import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  DEFAULT_CONFIG,
  loadConfig,
  type RouterConfig,
} from "../src/config.ts";
import {
  credentialFile,
  FileCredentialStore,
} from "../src/credential-store.ts";
import {
  createJevEvaluator,
  type EvaluationRequest,
  type EvaluationResult,
  RoutingFailure,
} from "../src/jev-client.ts";
import { MaskedKeyInput } from "../src/key-prompt.ts";
import {
  type AdapterDependencies,
  createSkillRouterExtension as createExtension,
} from "../src/pi-adapter.ts";
import type { RouteReport } from "../src/router.ts";
import { MemoryCredentialStore } from "./credential-fixtures.ts";

// Existing boundary fixtures use an explicit fake credential; never inherit a real key.
function createSkillRouterExtension(dependencies: AdapterDependencies) {
  return createExtension({
    getApiKey: () => "local-test-only",
    credentialStore: new MemoryCredentialStore(),
    ...dependencies,
  });
}

function score(
  request: EvaluationRequest,
  names: readonly string[],
): EvaluationResult {
  return {
    probabilities: Object.fromEntries(
      request.candidates.map((candidate) => [
        candidate.id,
        names.includes(candidate.name) ? 0.9 : 0.1,
      ]),
    ),
    model: "jev-test-version",
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function configuration(root: string, overrides: Partial<RouterConfig> = {}) {
  return {
    config: {
      ...DEFAULT_CONFIG,
      pinnedSkillPaths: [join(root, ".pi/skills/pinned/SKILL.md")],
      ...overrides,
    },
    issues: [],
  };
}

interface Payload {
  messages: Array<{ role: string; content: unknown }>;
}

async function harness(
  factory: (root: string) => ExtensionFactory,
  toolFirst = false,
  after?: ExtensionFactory,
  interaction?: { ui: Partial<ExtensionUIContext>; mode: "tui" | "rpc" },
) {
  const root = await mkdtemp(join(tmpdir(), "jev-pi-test-"));
  const payloads: Payload[] = [];
  const errors: unknown[] = [];
  for (const name of ["alpha", "beta", "pinned"]) {
    const dir = join(root, ".pi", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: UNIQUE_METADATA_${name.toUpperCase()}\n${name === "pinned" ? "disable-model-invocation: true\n" : ""}---\nUNIQUE_BODY_${name.toUpperCase()}\n`,
    );
  }
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body) as Payload);
    const toolCall = toolFirst && payloads.length === 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = toolCall
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "read-alpha",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({
                  path: join(root, ".pi", "skills", "alpha", "SKILL.md"),
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: "Complete." };
    for (const [patch, finish] of [
      [delta, null],
      [{}, toolCall ? "tool_calls" : "stop"],
    ]) {
      res.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: patch, finish_reason: finish }] })}\n\n`,
      );
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
  });
  const agentDir = join(root, "agent");
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("router-test", {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "local-test-only",
    api: "openai-completions",
    models: [
      {
        id: "mock",
        name: "Mock",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      },
    ],
  });
  const model = runtime.getModel("router-test", "mock");
  assert(model);
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [factory(root), ...(after ? [after] : [])],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager,
    tools: ["read"],
    thinkingLevel: "off",
  });
  assert.deepEqual(extensionsResult.errors, []);
  await session.bindExtensions({
    onError: (error) => errors.push(error),
    ...(interaction
      ? {
          mode: interaction.mode,
          uiContext: {
            notify() {},
            setStatus() {},
            setWidget() {},
            ...interaction.ui,
          } as ExtensionUIContext,
        }
      : {}),
  });
  session.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error"
    ) {
      errors.push(event.message.errorMessage);
    }
  });
  return {
    session,
    loader,
    payloads,
    errors,
    root,
    async close() {
      session.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

function payloadText(payload: Payload | undefined): string {
  assert(payload, "Expected an actual HTTP provider request");
  return JSON.stringify(payload.messages);
}

function promptIndicators() {
  const statuses: string[] = [];
  const widgets: string[] = [];
  const notices: string[] = [];
  return {
    statuses,
    widgets,
    notices,
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: (_key: string, text: string | undefined) => {
        if (text) statuses.push(text);
      },
      setWidget: (_key, factory, options) => {
        assert.equal(options?.placement, "aboveEditor");
        if (typeof factory === "function") {
          const component = factory(
            {} as Parameters<NonNullable<typeof factory>>[0],
            {} as Parameters<NonNullable<typeof factory>>[1],
          );
          const text = component.render(100).join("\n");
          assert.match(text, /\[jev-skills-retrieval\]/);
          widgets.push(text);
        }
      },
    } satisfies Partial<ExtensionUIContext>,
  };
}

test("visible Jev indicators distinguish filtered, zero-hit, fallback and disabled requests at the real provider boundary", async () => {
  for (const scenario of [
    "filtered",
    "zero",
    "fallback",
    "disabled",
  ] as const) {
    const indicator = promptIndicators();
    let evaluations = 0;
    const h = await harness(
      (root) =>
        createSkillRouterExtension({
          configuration: () =>
            configuration(
              root,
              scenario === "disabled" ? { maxAutoSkills: 0 } : {},
            ),
          evaluate: async (request) => {
            evaluations++;
            if (scenario === "fallback")
              throw new RoutingFailure(
                "authentication",
                "Jev authentication failed (HTTP 401).",
              );
            return score(request, scenario === "filtered" ? ["alpha"] : []);
          },
        }),
      true,
      undefined,
      { mode: "tui", ui: indicator.ui },
    );
    try {
      assert.match(indicator.widgets.at(-1) ?? "", /已启用.*等待任务/);
      const catalogCount = h.loader.getSkills().skills.length;
      await h.session.prompt("Task");
      const label =
        scenario === "fallback"
          ? "全量回退"
          : scenario === "disabled"
            ? "仅固定项"
            : "先筛选后发送";
      const count =
        scenario === "fallback"
          ? catalogCount
          : scenario === "filtered"
            ? 2
            : 1;
      const expected = new RegExp(
        `${label}.*请求含 ${count}/${catalogCount} 项`,
      );
      assert.match(indicator.statuses.at(-1) ?? "", expected);
      assert.match(indicator.widgets.at(-1) ?? "", expected);
      if (scenario === "filtered") {
        assert.match(
          indicator.statuses.at(-1) ?? "",
          /自动选择：alpha.*固定项：pinned/,
        );
        assert.match(
          indicator.widgets.at(-1) ?? "",
          /自动选择：alpha\s*\n固定项：pinned/,
        );
      } else if (scenario === "zero") {
        assert.match(
          indicator.widgets.at(-1) ?? "",
          /自动选择：无\s*\n固定项：pinned/,
        );
      } else {
        assert.doesNotMatch(indicator.widgets.at(-1) ?? "", /自动选择：/);
        assert.match(indicator.widgets.at(-1) ?? "", /固定项：pinned/);
      }
      assert.match(indicator.statuses.at(-1) ?? "", /发送前已核验/);
      assert.equal(evaluations, scenario === "disabled" ? 0 : 1);
      assert.equal(
        indicator.notices.filter((text) => expected.test(text)).length,
        1,
        "tool continuation must not repeat an unchanged notice",
      );
      assert.equal(h.payloads.length, 2);
      const text = payloadText(h.payloads[0]);
      assert.match(text, /UNIQUE_METADATA_PINNED/);
      if (scenario === "fallback") assert.match(text, /UNIQUE_METADATA_BETA/);
      else assert.doesNotMatch(text, /UNIQUE_METADATA_BETA/);
      if (scenario === "filtered") assert.match(text, /UNIQUE_METADATA_ALPHA/);
      await h.session.prompt("/jev-skill status");
      assert.match(indicator.notices.at(-1) ?? "", expected);
      assert.match(indicator.notices.at(-1) ?? "", /固定项：pinned/);
      const records = h.session.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "jev-skill-prompt",
        );
      assert.equal(records.length, 1);
      assert.doesNotMatch(
        JSON.stringify(records),
        /UNIQUE_METADATA|local-test-only|Task|"alpha"|"pinned"/,
      );
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  }
});

test("skill-name indicators replace the previous request's selection and commands show the current full list", async () => {
  const indicator = promptIndicators();
  let calls = 0;
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        configuration: () => configuration(root),
        evaluate: async (request) =>
          score(request, ++calls === 1 ? ["alpha"] : ["beta"]),
      }),
    false,
    undefined,
    { mode: "tui", ui: indicator.ui },
  );
  try {
    await h.session.prompt("First task");
    assert.match(indicator.widgets.at(-1) ?? "", /自动选择：alpha/);
    await h.session.prompt("Next task");
    assert.match(indicator.widgets.at(-1) ?? "", /自动选择：beta/);
    assert.doesNotMatch(indicator.widgets.at(-1) ?? "", /alpha/);
    assert.match(indicator.statuses.at(-1) ?? "", /自动选择：beta/);
    for (const command of ["/jev-skill status", "/skill-router-status"]) {
      await h.session.prompt(command);
      assert.match(
        indicator.notices.at(-1) ?? "",
        /自动选择：beta.*固定项：pinned/,
      );
      assert.doesNotMatch(indicator.notices.at(-1) ?? "", /alpha/);
    }
    assert.equal(calls, 2);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("persistent Jev widget shows credential wait and scoring before the provider runs", async () => {
  const indicator = promptIndicators();
  let enterKey: (value: string) => void = () => {};
  let opened: () => void = () => {};
  const inputOpened = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let finishEvaluation: () => void = () => {};
  let scoring: () => void = () => {};
  const scoringStarted = new Promise<void>((resolve) => {
    scoring = resolve;
  });
  const evaluationReleased = new Promise<void>((resolve) => {
    finishEvaluation = resolve;
  });
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        getApiKey: () => undefined,
        configuration: () => configuration(root),
        evaluate: async (request) => {
          scoring();
          await evaluationReleased;
          return score(request, ["alpha"]);
        },
      }),
    false,
    undefined,
    {
      mode: "rpc",
      ui: {
        ...indicator.ui,
        input: async () => {
          opened();
          return new Promise<string>((resolve) => {
            enterKey = resolve;
          });
        },
      },
    },
  );
  try {
    const pending = h.session.prompt("Task with missing key");
    await inputOpened;
    assert.match(
      indicator.widgets.at(-1) ?? "",
      /等待 API key.*尚未发送主模型/,
    );
    assert.equal(h.payloads.length, 0);
    enterKey("indicator-test-key");
    await scoringStarted;
    assert.match(
      indicator.widgets.at(-1) ?? "",
      /Jev 评分中.*已完成 0 批.*尚未发送主模型/,
    );
    assert(
      indicator.notices.some((text) =>
        /\[jev-skills-retrieval\] 已启动/.test(text),
      ),
    );
    assert.equal(h.payloads.length, 0);
    finishEvaluation();
    await pending;
    assert(indicator.widgets.some((text) => /已完成 1 批/.test(text)));
    assert.match(indicator.widgets.at(-1) ?? "", /先筛选后发送/);
    assert.deepEqual(h.errors, []);
  } finally {
    finishEvaluation();
    await h.close();
  }
});

test("actual provider payload contains selected and pinned metadata; tool continuation reuses it", async () => {
  let routes = 0;
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        configuration: () => configuration(root),
        evaluate: async (request) => {
          routes++;
          return score(request, ["alpha"]);
        },
      }),
    true,
  );
  try {
    await h.session.prompt("Work on alpha");
    assert.deepEqual(h.errors, []);
    assert.equal(routes, 1);
    assert.equal(
      h.payloads.length,
      2,
      "A real read tool causes a second request",
    );
    for (const payload of h.payloads) {
      const text = payloadText(payload);
      assert.match(text, /UNIQUE_METADATA_ALPHA/);
      assert.match(text, /UNIQUE_METADATA_PINNED/);
      assert.doesNotMatch(text, /UNIQUE_METADATA_BETA/);
    }
    assert.match(payloadText(h.payloads[1]), /UNIQUE_BODY_ALPHA/);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("explicit command body is loaded natively and raw input reaches the selector", async () => {
  let raw = "";
  const h = await harness(() =>
    createSkillRouterExtension({
      configuration: () => ({
        config: { ...DEFAULT_CONFIG, pinnedSkillPaths: [] },
        issues: [],
      }),
      evaluate: async (input) => {
        raw = input.state.currentMessage;
        return score(input, []);
      },
    }),
  );
  try {
    await h.session.prompt("/skill:pinned perform this");
    assert.deepEqual(h.errors, []);
    assert.equal(raw, "/skill:pinned perform this");
    const text = payloadText(h.payloads[0]);
    assert.match(text, /UNIQUE_BODY_PINNED/);
    assert.doesNotMatch(text, /UNIQUE_METADATA_ALPHA|UNIQUE_METADATA_BETA/);
    assert.match(
      await readFile(join(h.root, ".pi/skills/pinned/SKILL.md"), "utf8"),
      /disable-model-invocation: true/,
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("next user request replaces A with B and receives only raw chat and previous metadata", async () => {
  const requests: EvaluationRequest[] = [];
  const reports: RouteReport[] = [];
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        configuration: () => configuration(root),
        evaluate: async (request) => {
          requests.push(request);
          return score(request, [requests.length === 1 ? "alpha" : "beta"]);
        },
        onReport: (report) => reports.push(report),
      }),
    true,
  );
  try {
    await h.session.prompt("First task");
    await h.session.prompt("Next task");
    assert.equal(requests.length, 2);
    const state = requests[1]?.state;
    assert.equal(state?.currentMessage, "Next task");
    assert.deepEqual(state?.recentConversation.turns, [
      { user: "First task", assistant: "Complete." },
    ]);
    assert.deepEqual(state?.previousSkills.map((s) => s.name).sort(), [
      "alpha",
      "pinned",
    ]);
    assert.doesNotMatch(
      JSON.stringify(state),
      /UNIQUE_BODY|SKILL\.md|toolResult/,
    );
    const text = payloadText(h.payloads[2]);
    const catalogs = [
      ...text.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g),
    ];
    const lastCatalog = catalogs.at(-1)?.[1];
    assert(lastCatalog, text);
    assert.match(lastCatalog, /UNIQUE_METADATA_BETA/);
    assert.match(lastCatalog, /UNIQUE_METADATA_PINNED/);
    assert.doesNotMatch(lastCatalog, /UNIQUE_METADATA_ALPHA/);
    assert.equal(reports[1]?.model, "jev-test-version");
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("normal zero hits yields pinned-only metadata; a service failure restores the full catalog", async () => {
  for (const failure of [false, true]) {
    let last: RouteReport | undefined;
    const diagnostics: string[] = [];
    const h = await harness((root) =>
      createSkillRouterExtension({
        configuration: () => configuration(root),
        evaluate: async (request) => {
          if (failure)
            throw new RoutingFailure(
              "authentication",
              "Jev authentication failed (HTTP 401).",
            );
          return score(request, []);
        },
        onReport: (report) => {
          last = report;
        },
        onDiagnostic: (message) => diagnostics.push(message),
      }),
    );
    try {
      await h.session.prompt("Task");
      const text = payloadText(h.payloads[0]);
      assert.match(text, /UNIQUE_METADATA_PINNED/);
      if (failure) {
        assert.match(text, /UNIQUE_METADATA_ALPHA/);
        assert.match(text, /UNIQUE_METADATA_BETA/);
        assert.equal(last?.status, "fallback");
        assert.match(diagnostics.join("\n"), /authentication/);
      } else {
        assert.doesNotMatch(text, /UNIQUE_METADATA_ALPHA|UNIQUE_METADATA_BETA/);
        assert.equal(last?.status, "selected");
        assert.deepEqual(diagnostics, []);
      }
      assert.deepEqual(h.errors, []);
    } finally {
      await h.close();
    }
  }
});

test("invalid pinned path is diagnosed and valid pins survive config failure without an API request", async () => {
  let calls = 0;
  const diagnostics: string[] = [];
  const h = await harness((root) =>
    createSkillRouterExtension({
      configuration: () =>
        configuration(root, {
          pinnedSkillPaths: [
            join(root, ".pi/skills/pinned/SKILL.md"),
            join(root, "missing/SKILL.md"),
          ],
        }),
      evaluate: async (request) => {
        calls++;
        return score(request, []);
      },
      onDiagnostic: (message) => diagnostics.push(message),
    }),
  );
  try {
    await h.session.prompt("Task");
    assert.equal(calls, 0);
    assert.match(payloadText(h.payloads[0]), /UNIQUE_METADATA_PINNED/);
    assert.match(diagnostics.join("\n"), /missing.*SKILL\.md/);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("later forced prompt override emits a conflict diagnostic", async () => {
  const diagnostics: string[] = [];
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        configuration: () => configuration(root),
        evaluate: async (request) => score(request, ["alpha"]),
        onDiagnostic: (message) => diagnostics.push(message),
      }),
    false,
    (pi) => {
      pi.on("before_agent_start", () => ({
        systemPrompt: "Forced by another extension",
      }));
    },
  );
  try {
    await h.session.prompt("Task");
    assert.match(payloadText(h.payloads[0]), /Forced by another extension/);
    assert.match(diagnostics.join("\n"), /conflict.*forced systemPrompt/);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("a provider payload override is displayed as a mismatch even when Pi's planned prompt is still routed", async () => {
  const indicator = promptIndicators();
  const diagnostics: string[] = [];
  const h = await harness(
    (root) => async (pi) => {
      pi.on("before_provider_request", (event) => {
        const payload = event.payload as {
          messages: Array<{ role: string; content: unknown }>;
        };
        return {
          ...payload,
          messages: payload.messages.map((message) =>
            message.role === "system"
              ? { ...message, content: "Replaced at the provider boundary" }
              : message,
          ),
        };
      });
      await createSkillRouterExtension({
        configuration: () => configuration(root),
        evaluate: async (request) => score(request, ["alpha"]),
        onDiagnostic: (message) => diagnostics.push(message),
      })(pi);
    },
    false,
    undefined,
    { mode: "tui", ui: indicator.ui },
  );
  try {
    await h.session.prompt("Task");
    assert.match(
      payloadText(h.payloads[0]),
      /Replaced at the provider boundary/,
    );
    assert.doesNotMatch(payloadText(h.payloads[0]), /UNIQUE_METADATA/);
    assert.match(indicator.widgets.at(-1) ?? "", /目录被改写.*请求含 0/);
    assert.doesNotMatch(indicator.widgets.at(-1) ?? "", /先筛选后发送/);
    assert.match(diagnostics.join("\n"), /conflict/);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("cancellation while waiting for routing never restarts the Pi provider", async () => {
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = await harness((root) =>
    createSkillRouterExtension({
      configuration: () => configuration(root, { routeTimeoutMs: 40 }),
      evaluate: async () => {
        started?.();
        return new Promise(() => {});
      },
    }),
  );
  try {
    const prompt = h.session.prompt("Task to cancel");
    await ready;
    const cancelled = h.session.abort();
    await Promise.all([prompt, cancelled]);
    assert.equal(h.payloads.length, 0);
    assert(
      h.errors.every(
        (error) => typeof error === "string" && /aborted/i.test(error),
      ),
      JSON.stringify(h.errors),
    );
  } finally {
    await h.close();
  }
});

test("official Jev SDK and real Pi provider compose with project configuration", async () => {
  let sdkCalls = 0;
  const evaluate = createJevEvaluator({
    getApiKey: () => "local-test-only",
    fetch: async () => {
      sdkCalls++;
      // Build a response from the actual per-catalog candidate IDs captured below.
      return Response.json(sdkResponse);
    },
  });
  let sdkResponse: unknown;
  const h = await harness((root) =>
    createSkillRouterExtension({
      configuration: () => loadConfig(root, join(root, "agent")),
      evaluate: async (request) => {
        sdkResponse = {
          model: "jev-sdk-test",
          answers: Object.fromEntries(
            request.candidates.map((c) => [
              c.id,
              { type: "noul", noul: c.name === "beta" ? 0.9 : 0.1 },
            ]),
          ),
          usage: { input_tokens: 25, output_tokens: 2 },
        };
        return evaluate(request);
      },
    }),
  );
  try {
    await writeFile(
      join(h.root, ".pi/skill-router.json"),
      JSON.stringify({ pinnedSkillPaths: ["./skills/pinned/SKILL.md"] }),
    );
    await h.session.prompt("Task");
    assert.equal(sdkCalls, 1);
    const text = payloadText(h.payloads[0]);
    assert.match(text, /UNIQUE_METADATA_BETA/);
    assert.match(text, /UNIQUE_METADATA_PINNED/);
    assert.doesNotMatch(text, /UNIQUE_METADATA_ALPHA/);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("a later successful zero hit removes the active automatic section", async () => {
  let calls = 0;
  const h = await harness(() =>
    createSkillRouterExtension({
      configuration: () => ({
        config: { ...DEFAULT_CONFIG, pinnedSkillPaths: [] },
        issues: [],
      }),
      evaluate: async (request) =>
        score(request, ++calls === 1 ? ["alpha"] : []),
    }),
  );
  try {
    await h.session.prompt("First task");
    await h.session.prompt("Unrelated task");
    assert.equal(calls, 2);
    const second = h.payloads[1];
    assert(second);
    // The OpenAI adapter folds prompt deltas into the leading system message.
    assert.doesNotMatch(
      payloadText(second),
      /UNIQUE_METADATA_ALPHA|UNIQUE_METADATA_BETA|<available_skills>/,
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("reloading an existing conversation clearly skips unsupported history takeover", async () => {
  let calls = 0;
  const diagnostics: string[] = [];
  const indicator = promptIndicators();
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        configuration: () => configuration(root),
        evaluate: async (request) => {
          calls++;
          return score(request, ["alpha"]);
        },
        onDiagnostic: (message) => diagnostics.push(message),
      }),
    false,
    undefined,
    { mode: "tui", ui: indicator.ui },
  );
  try {
    await h.session.prompt("First task");
    await h.session.reload();
    await h.session.prompt("Existing history");
    assert.equal(calls, 1);
    assert.match(diagnostics.join("\n"), /requires a fresh session/);
    assert.match(payloadText(h.payloads[1]), /UNIQUE_METADATA_BETA/);
    assert.match(indicator.widgets.at(-1) ?? "", /未筛选.*旧会话/);
    assert.doesNotMatch(indicator.widgets.at(-1) ?? "", /先筛选后发送/);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomArguments = Parameters<CustomFactory>;

function terminalInput(
  onOpen: (input: MaskedKeyInput) => void | Promise<void>,
): Partial<ExtensionUIContext> {
  return {
    custom: async <T>(factory: CustomFactory): Promise<T> => {
      let done: (value: unknown) => void = () => {};
      const result = new Promise<unknown>((resolve) => {
        done = resolve;
      });
      const component = await factory(
        { requestRender() {} } as CustomArguments[0],
        {} as CustomArguments[1],
        {
          matches: (data: string) => matchesKey(data, "alt+v"),
        } as unknown as CustomArguments[2],
        done,
      );
      assert(component instanceof MaskedKeyInput);
      component.focused = true;
      try {
        await onOpen(component);
        return (await result) as T;
      } finally {
        component.dispose();
      }
    },
  };
}

function sdkTransport() {
  const requests: Array<{
    url: string;
    authorization: string | null;
    body: Record<string, unknown>;
  }> = [];
  const fetch: NonNullable<AdapterDependencies["fetch"]> = async (
    url,
    init,
  ) => {
    let bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
    if (new Headers(init?.headers).get("content-encoding") === "zstd")
      bytes = zstdDecompressSync(bytes);
    const body = JSON.parse(bytes.toString()) as Record<string, unknown>;
    requests.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    return Response.json({
      model: "jev-1.14.0",
      answers: Object.fromEntries(
        Object.keys(body.questions as object).map((id) => [
          id,
          { type: "noul", noul: 0.9 },
        ]),
      ),
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  };
  return { requests, fetch };
}

function assertOnlyPiAbort(errors: readonly unknown[]) {
  assert(
    errors.every(
      (error) => typeof error === "string" && /aborted/i.test(error),
    ),
    JSON.stringify(errors),
  );
}

test("TUI key dialog blocks provider work, resumes the same task and keeps the key out of transcripts", async () => {
  const transport = sdkTransport();
  const key = "test-tui-session-credential";
  const environmentBefore = process.env.TYPESAFE_API_KEY;
  let opened: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let prompts = 0;
  const ui = terminalInput(async (input) => {
    prompts++;
    input.handleInput(`\x1b[200~${key}\x1b[201~`);
    assert.doesNotMatch(
      input.render(80).join("\n"),
      /test-tui-session-credential/,
    );
    opened();
    await released;
    input.handleInput("\r");
  });
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        getApiKey: () => undefined,
        fetch: transport.fetch,
        configuration: () => configuration(root, { routeTimeoutMs: 100 }),
      }),
    false,
    undefined,
    { ui, mode: "tui" },
  );
  try {
    const pending = h.session.prompt("Original waiting task");
    await ready;
    // Waiting for the user must not consume the remote routing deadline.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(transport.requests.length, 0);
    assert.equal(h.payloads.length, 0);
    release();
    await pending;
    assert.equal(transport.requests.length, 1);
    assert.equal(h.payloads.length, 1);
    assert.equal(transport.requests[0]?.authorization, `Bearer ${key}`);
    assert.equal(
      JSON.parse(transport.requests[0]?.body.state as string).currentMessage,
      "Original waiting task",
    );
    await h.session.prompt("Follow-up using the stored credential");
    assert.equal(prompts, 1);
    assert.equal(transport.requests.length, 2);
    assert(
      transport.requests.every(
        (request) => request.authorization === `Bearer ${key}`,
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(h.payloads),
      /test-tui-session-credential/,
    );
    assert.doesNotMatch(
      JSON.stringify(h.session.sessionManager.getBranch()),
      /test-tui-session-credential/,
    );
    assert.doesNotMatch(
      JSON.stringify(transport.requests.map((request) => request.body)),
      /test-tui-session-credential/,
    );
    assert.equal(process.env.TYPESAFE_API_KEY, environmentBefore);
    assert.deepEqual(h.errors, []);
  } finally {
    release();
    await h.close();
  }
});

test("/jev-skill registers described subcommand completions and help/status stay outside model history", async () => {
  const notices: string[] = [];
  const transport = sdkTransport();
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        fetch: transport.fetch,
        configuration: () => configuration(root),
      }),
    false,
    undefined,
    { mode: "rpc", ui: { notify: (message) => notices.push(message) } },
  );
  try {
    const commands = h.loader.getExtensions().extensions[0]?.commands;
    const command = commands?.get("jev-skill");
    assert(command);
    assert(command.description?.includes("apikey"));
    const all = await command.getArgumentCompletions?.("");
    assert.deepEqual(
      all?.map((item) => item.value),
      ["apikey", "baseurl", "status", "help"],
    );
    assert(all?.every((item) => item.description));
    assert.deepEqual(
      (await command.getArgumentCompletions?.("api"))?.map(
        (item) => item.value,
      ),
      ["apikey"],
    );
    assert.deepEqual(
      (await command.getArgumentCompletions?.("baseurl re"))?.map(
        (item) => item.value,
      ),
      ["baseurl reset"],
    );
    assert.deepEqual(
      (await command.getArgumentCompletions?.("apikey re"))?.map(
        (item) => item.value,
      ),
      ["apikey reset"],
    );
    assert.deepEqual(
      (await command.getArgumentCompletions?.("apikey "))?.map(
        (item) => item.value,
      ),
      ["apikey add", "apikey reset"],
    );
    assert.equal(
      await command.getArgumentCompletions?.("apikey add test-secret"),
      null,
    );
    assert.equal(
      await command.getArgumentCompletions?.("no-such-command"),
      null,
    );
    for (const text of [
      "/jev-skill",
      "/jev-skill help",
      "/jev-skill status",
      "/skill-router-status",
      "/jev-skill unknown",
    ])
      await h.session.prompt(text);
    assert(notices.some((value) => value.includes("/jev-skill apikey")));
    assert(
      notices.some((value) => value.includes("API key：已配置（环境变量")),
    );
    assert.doesNotMatch(notices.join(), /local-test-only/);
    assert.equal(transport.requests.length, 0);
    assert.equal(h.payloads.length, 0);
    assert.doesNotMatch(
      JSON.stringify(h.session.sessionManager.getBranch()),
      /jev-skill|skill-router-status/,
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("saved API key survives a fresh Pi extension in headless mode; reset removes disk credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-pi-persistent-home-"));
  const file = credentialFile(home);
  const key = "test-pi-durable-key";
  const transport = sdkTransport();
  let h: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    h = await harness(
      (root) =>
        createSkillRouterExtension({
          getApiKey: () => undefined,
          credentialStore: new FileCredentialStore(file),
          fetch: transport.fetch,
          configuration: () => configuration(root),
        }),
      false,
      undefined,
      { mode: "rpc", ui: { input: async () => key } },
    );
    await h.session.prompt(
      "Initial task with automatic persistent credential input",
    );
    assert.equal(transport.requests[0]?.authorization, `Bearer ${key}`);
    assert.equal(new FileCredentialStore(file).read(), key);
    assert.doesNotMatch(
      JSON.stringify({
        payloads: h.payloads,
        branch: h.session.sessionManager.getBranch(),
      }),
      /test-pi-durable-key/,
    );
    await h.close();
    h = undefined;
    h = await harness((root) =>
      createSkillRouterExtension({
        getApiKey: () => undefined,
        credentialStore: new FileCredentialStore(file),
        fetch: transport.fetch,
        configuration: () => configuration(root),
      }),
    );
    await h.session.prompt("Next process uses the saved file without UI");
    assert.equal(transport.requests[1]?.authorization, `Bearer ${key}`);
    await h.session.prompt("/jev-skill apikey reset");
    assert.equal(new FileCredentialStore(file).read(), undefined);
    assert.equal(transport.requests.length, 2);
    assert.equal(h.payloads.length, 1);
    assert.deepEqual(h.errors, []);
  } finally {
    await h?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a failed credential save blocks Pi before SDK/provider requests and keeps secret-bearing filesystem errors private", async () => {
  const transport = sdkTransport();
  const reports: RouteReport[] = [];
  const notices: string[] = [];
  const store = new MemoryCredentialStore();
  store.save = () => {
    throw new Error("secret-storage-error");
  };
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        getApiKey: () => undefined,
        credentialStore: store,
        fetch: transport.fetch,
        configuration: () => configuration(root),
        onReport: (report) => reports.push(report),
      }),
    false,
    undefined,
    {
      mode: "rpc",
      ui: {
        input: async () => "unsaved-test-key",
        notify: (message) => notices.push(message),
      },
    },
  );
  try {
    await h.session.prompt("Task whose credential cannot be saved");
    assert.equal(transport.requests.length, 0);
    assert.equal(h.payloads.length, 0);
    assert.equal(reports[0]?.status, "blocked");
    assert(notices.some((message) => message.includes("本地凭据")));
    assert.doesNotMatch(
      JSON.stringify({
        reports,
        notices,
        branch: h.session.sessionManager.getBranch(),
      }),
      /unsaved-test-key|secret-storage-error/,
    );
    assertOnlyPiAbort(h.errors);
  } finally {
    await h.close();
  }
});

test("/jev-skill apikey uses masked editing, preserves cancellation and changes later SDK credentials without model calls", async () => {
  const notices: string[] = [];
  const answers = ["command-secret-one", undefined, "command-secret-two"];
  const transport = sdkTransport();
  let dialogs = 0;
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        getApiKey: () => undefined,
        fetch: transport.fetch,
        configuration: () => configuration(root),
      }),
    false,
    undefined,
    {
      mode: "tui",
      ui: {
        ...terminalInput((input) => {
          dialogs++;
          const value = answers.shift();
          assert.match(input.render(100).join("\n"), /\/jev-skill apikey/);
          if (value === undefined) input.handleInput("\x1b");
          else {
            input.handleInput(`\x1b[200~${value}\x1b[201~`);
            assert.doesNotMatch(input.render(100).join("\n"), /command-secret/);
            input.handleInput("\r");
          }
        }),
        notify: (message) => notices.push(message),
      },
    },
  );
  try {
    for (const [index, key] of [
      "command-secret-one",
      "command-secret-one",
      "command-secret-two",
    ].entries()) {
      await h.session.prompt("/jev-skill apikey");
      assert.equal(transport.requests.length, index);
      assert.equal(h.payloads.length, index);
      await h.session.prompt(`Task ${index}`);
      assert.equal(transport.requests[index]?.authorization, `Bearer ${key}`);
    }
    await h.session.prompt("/jev-skill status");
    assert.equal(dialogs, 3);
    assert(notices.some((value) => value.includes("已取消 API key 修改")));
    assert.doesNotMatch(
      JSON.stringify({
        notices,
        payloads: h.payloads,
        branch: h.session.sessionManager.getBranch(),
        bodies: transport.requests.map((request) => request.body),
      }),
      /command-secret|\/jev-skill/,
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("/jev-skill apikey add persists the literal key across restarts without dialogs, model calls or secret-bearing diagnostics", async () => {
  const notices: string[] = [];
  const transport = sdkTransport();
  let file = "";
  const h = await harness(
    (root) => {
      file = credentialFile(join(root, "credential-home"));
      return createSkillRouterExtension({
        getApiKey: () => undefined,
        credentialStore: new FileCredentialStore(file),
        fetch: transport.fetch,
        configuration: () => configuration(root),
      });
    },
    false,
    undefined,
    {
      mode: "rpc",
      ui: {
        notify: (message) => notices.push(message),
        input: async () => {
          throw new Error("Must not open a dialog");
        },
      },
    },
  );
  try {
    for (const key of ["literal-add-secret-$()-'", "replacement-add-secret"]) {
      const previousRequests = transport.requests.length;
      await h.session.prompt(`/jev-skill apikey add ${key}`);
      assert.equal(new FileCredentialStore(file).read(), key);
      assert.equal(transport.requests.length, previousRequests);
      assert.equal(h.payloads.length, previousRequests);
      await h.session.prompt("Task after saving key");
      assert.equal(transport.requests.at(-1)?.authorization, `Bearer ${key}`);
    }
    for (const argument of [
      "add",
      "add   ",
      "add invalid-secret\nsecond-line",
      "add invalid-secret\0data",
    ]) {
      await h.session.prompt(`/jev-skill apikey ${argument}`);
      assert.equal(
        new FileCredentialStore(file).read(),
        "replacement-add-secret",
      );
    }
    await h.session.prompt("/jev-skill status");
    assert(notices.some((value) => value.includes("API key 已保存")));
    assert(notices.some((value) => value.includes("API key 不能为空")));
    assert.doesNotMatch(
      JSON.stringify({
        notices,
        errors: h.errors,
        branch: h.session.sessionManager.getBranch(),
        payloads: h.payloads,
        bodies: transport.requests.map((request) => request.body),
      }),
      /add-secret|invalid-secret|second-line/,
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("/jev-skill baseurl persists project roots, validates dialog input and sends later SDK calls to that root; reset restores user root", async () => {
  const notices: string[] = [];
  const answers = [" ", "ftp://invalid.example", "https://dialog.example/jev/"];
  const transport = sdkTransport();
  let prompts = 0;
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        fetch: transport.fetch,
        configuration: () => loadConfig(root, join(root, "agent")),
      }),
    false,
    undefined,
    {
      mode: "rpc",
      ui: {
        notify: (message) => notices.push(message),
        input: async (title, placeholder) => {
          prompts++;
          assert.match(title, /\/jev-skill baseurl/);
          assert.match(placeholder ?? "", /https:\/\/api.typesafe.ai/);
          return answers.shift();
        },
      },
    },
  );
  try {
    await mkdir(join(h.root, "agent"), { recursive: true });
    await writeFile(
      join(h.root, "agent", "skill-router.json"),
      JSON.stringify({ baseUrl: "https://user.example/jev", maxAutoSkills: 1 }),
    );
    const file = join(h.root, ".pi", "skill-router.json");
    await writeFile(
      file,
      JSON.stringify({ minProbability: 0.7, model: "jev-1.14.0" }),
    );
    await h.session.prompt(
      "/jev-skill baseurl https://project.example/gateway/",
    );
    assert.equal(transport.requests.length, 0);
    assert.equal(h.payloads.length, 0);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      minProbability: 0.7,
      model: "jev-1.14.0",
      baseUrl: "https://project.example/gateway",
    });
    await h.session.prompt("First task after base URL command");
    assert.equal(
      transport.requests[0]?.url,
      "https://project.example/gateway/v1/systemone",
    );
    await h.session.prompt("/jev-skill baseurl");
    assert.equal(prompts, 3);
    await h.session.prompt("Second task after URL dialog");
    assert.equal(
      transport.requests[1]?.url,
      "https://dialog.example/jev/v1/systemone",
    );
    await h.session.prompt("/jev-skill baseurl reset");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      minProbability: 0.7,
      model: "jev-1.14.0",
    });
    await h.session.prompt("Third task after URL reset");
    assert.equal(
      transport.requests[2]?.url,
      "https://user.example/jev/v1/systemone",
    );
    assert.doesNotMatch(
      JSON.stringify(h.payloads),
      /\/jev-skill|https:\/\/project.example|https:\/\/dialog.example/,
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("/jev-skill rejects unsafe URLs, plaintext key arguments and broken config without model calls or secret-bearing diagnostics", async () => {
  const notices: string[] = [];
  const transport = sdkTransport();
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        fetch: transport.fetch,
        configuration: () => configuration(root),
      }),
    false,
    undefined,
    {
      mode: "rpc",
      ui: {
        notify: (message) => notices.push(message),
        input: async () => {
          throw new Error("dialog-secret");
        },
      },
    },
  );
  try {
    const file = join(h.root, ".pi", "skill-router.json");
    const before = '{"minProbability":0.7}';
    await writeFile(file, before);
    for (const command of [
      "apikey plaintext-secret",
      "baseurl ftp://example.com",
      "baseurl https://user:url-secret@example.com",
      "baseurl https://example.com?key=query-secret",
      "baseurl https://example.com#fragment-secret",
      "baseurl",
      "apikey",
    ])
      await h.session.prompt(`/jev-skill ${command}`);
    assert.equal(await readFile(file, "utf8"), before);
    await writeFile(file, "{broken-json");
    await h.session.prompt("/jev-skill baseurl https://valid.example");
    assert.equal(await readFile(file, "utf8"), "{broken-json");
    assert(notices.some((value) => value.includes("无法保存项目 Base URL")));
    assert.doesNotMatch(
      JSON.stringify({
        notices,
        errors: h.errors,
        branch: h.session.sessionManager.getBranch(),
      }),
      /plaintext-secret|url-secret|query-secret|fragment-secret|dialog-secret/,
    );
    assert.equal(transport.requests.length, 0);
    assert.equal(h.payloads.length, 0);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("/jev-skill baseurl cancellation preserves the exact file and command mutations are rejected while a task runs", async () => {
  const notices: string[] = [];
  let opened: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dialogs = 0;
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        configuration: () => configuration(root),
        evaluate: async (request) => {
          opened();
          await released;
          return score(request, ["alpha"]);
        },
      }),
    false,
    undefined,
    {
      mode: "rpc",
      ui: {
        notify: (message) => notices.push(message),
        input: async () => {
          dialogs++;
          return undefined;
        },
      },
    },
  );
  try {
    const file = join(h.root, ".pi", "skill-router.json");
    const before = '{"baseUrl":"https://before.example", "maxAutoSkills": 1}';
    await writeFile(file, before);
    await h.session.prompt("/jev-skill baseurl");
    assert.equal(dialogs, 1);
    assert.equal(await readFile(file, "utf8"), before);
    assert(notices.some((value) => value.includes("已取消 Base URL 修改")));
    const pending = h.session.prompt("Longer normal task");
    await started;
    await h.session.prompt(
      "/jev-skill baseurl https://should-not-save.example",
    );
    await h.session.prompt("/jev-skill apikey");
    await h.session.prompt("/jev-skill apikey add busy-secret");
    assert.equal(dialogs, 1);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(
      notices.filter((value) => value.includes("当前任务正在运行")).length,
      3,
    );
    release();
    await pending;
    assert.equal(h.payloads.length, 1);
    assert.deepEqual(h.errors, []);
  } finally {
    release();
    await h.close();
  }
});

test("headless /jev-skill accepts explicit Base URL but never opens a credential dialog or sends a model request", async () => {
  const transport = sdkTransport();
  const store = new MemoryCredentialStore();
  const h = await harness((root) =>
    createSkillRouterExtension({
      getApiKey: () => undefined,
      credentialStore: store,
      fetch: transport.fetch,
      configuration: () => configuration(root),
    }),
  );
  try {
    await h.session.prompt("/jev-skill apikey");
    await h.session.prompt("/jev-skill apikey add headless-add-secret");
    assert.equal(store.key, "headless-add-secret");
    await h.session.prompt("/jev-skill baseurl");
    await h.session.prompt("/jev-skill baseurl https://headless.example");
    assert.equal(
      JSON.parse(
        await readFile(join(h.root, ".pi", "skill-router.json"), "utf8"),
      ).baseUrl,
      "https://headless.example",
    );
    assert.equal(transport.requests.length, 0);
    assert.equal(h.payloads.length, 0);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("RPC empty key input stays blocked until a nonempty value is supplied", async () => {
  const transport = sdkTransport();
  let prompts = 0;
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        getApiKey: () => undefined,
        fetch: transport.fetch,
        configuration: () => configuration(root),
      }),
    false,
    undefined,
    {
      mode: "rpc",
      ui: {
        input: async () => {
          assert.equal(transport.requests.length, 0);
          prompts++;
          return prompts === 1 ? "   " : "test-rpc-key";
        },
      },
    },
  );
  try {
    await h.session.prompt("RPC task");
    assert.equal(prompts, 2);
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0]?.authorization, "Bearer test-rpc-key");
    assert.equal(h.payloads.length, 1);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("cancelling the key dialog cancels this task instead of falling back; the next task can retry", async () => {
  const transport = sdkTransport();
  const reports: RouteReport[] = [];
  const indicator = promptIndicators();
  let prompts = 0;
  const ui = terminalInput((input) => {
    if (++prompts === 1) input.handleInput("\x1b");
    else {
      input.handleInput("test-retry-key");
      input.handleInput("\r");
    }
  });
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        getApiKey: () => undefined,
        fetch: transport.fetch,
        configuration: () => configuration(root),
        onReport: (report) => reports.push(report),
      }),
    false,
    undefined,
    { ui: { ...indicator.ui, ...ui }, mode: "tui" },
  );
  try {
    await h.session.prompt("Cancelled before credentials");
    assert.equal(transport.requests.length, 0);
    assert.equal(h.payloads.length, 0);
    assert.equal(reports[0]?.status, "blocked");
    assert.equal(reports[0]?.reason, "missing_key");
    assert.match(indicator.widgets.at(-1) ?? "", /未发送主模型/);
    assertOnlyPiAbort(h.errors);
    h.errors.length = 0;
    await h.session.prompt("Retry with credentials");
    assert.equal(prompts, 2);
    assert.equal(transport.requests.length, 1);
    assert.equal(h.payloads.length, 1);
    assert.equal(reports[1]?.status, "selected");
    assert.match(indicator.widgets.at(-1) ?? "", /先筛选后发送/);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("missing key without UI blocks the task and never sends a provider request", async () => {
  const transport = sdkTransport();
  const reports: RouteReport[] = [];
  const diagnostics: string[] = [];
  const h = await harness((root) =>
    createSkillRouterExtension({
      getApiKey: () => undefined,
      fetch: transport.fetch,
      configuration: () => configuration(root),
      onReport: (report) => reports.push(report),
      onDiagnostic: (message) => diagnostics.push(message),
    }),
  );
  try {
    await h.session.prompt("Headless task");
    assert.equal(transport.requests.length, 0);
    assert.equal(h.payloads.length, 0);
    assert.equal(reports[0]?.status, "blocked");
    assert.match(diagnostics.join("\n"), /无法弹出输入框/);
    assertOnlyPiAbort(h.errors);
  } finally {
    await h.close();
  }
});

test("key dialog failure blocks execution without exposing its error text", async () => {
  const transport = sdkTransport();
  const diagnostics: string[] = [];
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        getApiKey: () => undefined,
        fetch: transport.fetch,
        configuration: () => configuration(root),
        onDiagnostic: (message) => diagnostics.push(message),
      }),
    false,
    undefined,
    {
      mode: "rpc",
      ui: {
        input: async () => {
          throw new Error("sensitive-dialog-key");
        },
      },
    },
  );
  try {
    await h.session.prompt("Task with failed dialog");
    assert.equal(transport.requests.length, 0);
    assert.equal(h.payloads.length, 0);
    assert.match(diagnostics.join("\n"), /无法打开/);
    assert.doesNotMatch(
      JSON.stringify({
        diagnostics,
        entries: h.session.sessionManager.getBranch(),
        errors: h.errors,
      }),
      /sensitive-dialog-key/,
    );
    assertOnlyPiAbort(h.errors);
  } finally {
    await h.close();
  }
});

test("a credential disappearing after the preflight still blocks instead of falling back", async () => {
  const transport = sdkTransport();
  let reads = 0;
  const reports: RouteReport[] = [];
  const h = await harness((root) =>
    createSkillRouterExtension({
      getApiKey: () => (++reads === 1 ? "test-ephemeral-key" : undefined),
      fetch: transport.fetch,
      configuration: () => configuration(root),
      onReport: (report) => reports.push(report),
    }),
  );
  try {
    await h.session.prompt("Task with removed environment credential");
    assert.equal(transport.requests.length, 0);
    assert.equal(h.payloads.length, 0);
    assert.equal(reports[0]?.status, "blocked");
    assert.equal(reports[0]?.reason, "missing_key");
    assertOnlyPiAbort(h.errors);
  } finally {
    await h.close();
  }
});
