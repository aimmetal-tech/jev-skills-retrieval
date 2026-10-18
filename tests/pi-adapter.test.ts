import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  loadConfig,
  type RouterConfig,
} from "../src/config.ts";
import {
  createJevEvaluator,
  type EvaluationRequest,
  type EvaluationResult,
  RoutingFailure,
} from "../src/jev-client.ts";
import { createSkillRouterExtension } from "../src/pi-adapter.ts";
import type { RouteReport } from "../src/router.ts";

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
  const h = await harness((root) =>
    createSkillRouterExtension({
      configuration: () => configuration(root),
      evaluate: async (request) => {
        calls++;
        return score(request, ["alpha"]);
      },
      onDiagnostic: (message) => diagnostics.push(message),
    }),
  );
  try {
    await h.session.prompt("First task");
    await h.session.reload();
    await h.session.prompt("Existing history");
    assert.equal(calls, 1);
    assert.match(diagnostics.join("\n"), /requires a fresh session/);
    assert.match(payloadText(h.payloads[1]), /UNIQUE_METADATA_BETA/);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
