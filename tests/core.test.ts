import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import {
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { buildRoutingState } from "../src/context.ts";
import {
  createJevEvaluator,
  RoutingFailure,
  validateResponse,
} from "../src/jev-client.ts";
import { route } from "../src/router.ts";
import {
  autoCandidates,
  selectAutomatic,
  uniqueSkills,
} from "../src/selection.ts";

function skill(name: string, path = name): Skill {
  const filePath = join(tmpdir(), "jev-fake-catalog", path, "SKILL.md");
  return {
    name,
    description: `Metadata for ${path}`,
    filePath,
    baseDir: join(filePath, ".."),
    disableModelInvocation: false,
    sourceInfo: {
      path: filePath,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
  };
}
const config = { ...DEFAULT_CONFIG, pinnedSkillPaths: [] };
const state = buildRoutingState("Current requirements", [], [], config);

test("same-name skills keep distinct path IDs and tie sorting is stable", () => {
  const a = skill("same", "one");
  const b = skill("same", "two");
  const candidates = autoCandidates([a, b, a], []);
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0]?.id, candidates[1]?.id);
  assert.equal(autoCandidates([b, a], [])[1]?.id, candidates[0]?.id);
  const probabilities = Object.fromEntries(candidates.map((c) => [c.id, 0.65]));
  assert.deepEqual(
    selectAutomatic(candidates, probabilities, config),
    selectAutomatic([...candidates].reverse(), probabilities, config),
  );
  assert.equal(uniqueSkills([a, b, a]).length, 2);
});

test("automatic count and native rendered metadata budgets exclude pinned and disabled skills", () => {
  const large = { ...skill("huge"), description: "&".repeat(1000) };
  const small = skill("small");
  const pinned = skill("fixed");
  const disabled = { ...skill("manual"), disableModelInvocation: true };
  const candidates = autoCandidates([large, small, pinned, disabled], [pinned]);
  assert.equal(candidates.length, 2);
  const probabilities = Object.fromEntries(candidates.map((c) => [c.id, 0.9]));
  const budget = formatSkillsForPrompt([small]).length;
  const selected = selectAutomatic(candidates, probabilities, {
    ...config,
    maxAutoSkills: 1,
    autoMetadataMaxChars: budget,
  });
  assert.deepEqual(selected, [small]);
  assert.equal(
    selectAutomatic(candidates, probabilities, {
      ...config,
      autoMetadataMaxChars: budget - 1,
    }).length,
    0,
  );
  assert.equal(
    selectAutomatic(candidates, probabilities, {
      ...config,
      minProbability: 0.91,
    }).length,
    0,
  );
});

test("history uses newest visible text, marks truncation and never budgets current message", () => {
  const history = [
    { user: "old", assistant: "old reply" },
    { user: "recent", assistant: "answer" },
    { user: "newest", assistant: "response" },
  ];
  const current = "KEEP_ME".repeat(2000);
  const result = buildRoutingState(current, history, [skill("previous")], {
    ...config,
    historyMaxTurns: 2,
    historyMaxChars: 11,
  });
  assert.equal(result.currentMessage, current);
  assert.deepEqual(result.recentConversation, {
    turns: [{ user: "est", assistant: "response" }],
    truncated: true,
  });
  assert.deepEqual(result.previousSkills, [
    { name: "previous", description: "Metadata for previous" },
  ]);
  assert.deepEqual(
    buildRoutingState("now", history, [], { ...config, historyMaxTurns: 0 })
      .recentConversation,
    { turns: [], truncated: true },
  );
  assert.equal(
    buildRoutingState("now", history, [], { ...config, historyMaxChars: 0 })
      .recentConversation.turns.length,
    0,
  );
});

test("automatic metadata budget uses Pi's active read tool wording", () => {
  const candidate = skill("small");
  const candidates = autoCandidates([candidate], []);
  const probabilities = Object.fromEntries(candidates.map((c) => [c.id, 0.9]));
  for (const reader of ["read", "bash", "indirect"] as const) {
    const budget = formatSkillsForPrompt([candidate], reader).length;
    assert.deepEqual(
      selectAutomatic(
        candidates,
        probabilities,
        { ...config, autoMetadataMaxChars: budget },
        reader,
      ),
      [candidate],
    );
    assert.deepEqual(
      selectAutomatic(
        candidates,
        probabilities,
        { ...config, autoMetadataMaxChars: budget - 1 },
        reader,
      ),
      [],
    );
  }
});

test("configuration merges project scalars and unions relative pins; bad fields keep valid pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-test-"));
  try {
    const agent = join(root, "agent");
    await mkdir(agent);
    await mkdir(join(root, ".pi"));
    await writeFile(
      join(agent, "skill-router.json"),
      JSON.stringify({
        minProbability: 0.7,
        maxAutoSkills: 2,
        pinnedSkillPaths: ["../shared/SKILL.md"],
      }),
    );
    await writeFile(
      join(root, ".pi/skill-router.json"),
      JSON.stringify({
        minProbability: 0.8,
        pinnedSkillPaths: ["../shared/SKILL.md", "./skills/x/SKILL.md"],
      }),
    );
    const loaded = loadConfig(root, agent);
    assert.deepEqual(loaded.issues, []);
    assert.equal(loaded.config.minProbability, 0.8);
    assert.equal(loaded.config.maxAutoSkills, 2);
    assert.deepEqual(loaded.config.pinnedSkillPaths, [
      join(root, "shared/SKILL.md"),
      join(root, ".pi/skills/x/SKILL.md"),
    ]);
    await writeFile(
      join(root, ".pi/skill-router.json"),
      JSON.stringify({
        routeTimeoutMs: -1,
        minProbability: 2,
        pinnedSkillPaths: ["./skills/x/SKILL.md", null],
        apiKey: "must-not-echo",
      }),
    );
    const invalid = loadConfig(root, agent);
    assert.equal(invalid.issues.length, 4);
    assert.equal(invalid.config.pinnedSkillPaths.length, 2);
    assert.doesNotMatch(invalid.issues.join(), /must-not-echo/);
    await writeFile(join(root, ".pi/skill-router.json"), "{not-json");
    assert.match(loadConfig(root, agent).issues.join(), /Invalid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("total deadline aborts a hung evaluator and prevents late results from changing fallback", async () => {
  let signal: AbortSignal | undefined;
  const catalog = [skill("auto")];
  const pinned = [{ ...skill("manual"), disableModelInvocation: false }];
  const result = await route(
    {
      catalog,
      pinned,
      state,
      config: { ...config, routeTimeoutMs: 20 },
      signal: undefined,
      issues: [],
    },
    async (request) => {
      signal = request.signal;
      return new Promise(() => {});
    },
  );
  assert.equal(result.report.reason, "timeout");
  assert.equal(signal?.aborted, true);
  assert.equal(result.skills.length, 2);
  assert(result.report.elapsedMs < 500);
});

test("caller cancellation does not restore or restart the full catalog", async () => {
  const controller = new AbortController();
  const promise = route(
    {
      catalog: [skill("auto")],
      pinned: [],
      state,
      config,
      signal: controller.signal,
      issues: [],
    },
    async () => new Promise(() => {}),
  );
  controller.abort();
  const result = await promise;
  assert.equal(result.report.status, "cancelled");
  assert.deepEqual(result.skills, []);
});

test("official SDK submits independent Noul questions with shared state and records actual model", async () => {
  const candidates = autoCandidates([skill("a"), skill("b")], []);
  let body: Record<string, unknown> = {};
  let calls = 0;
  const evaluate = createJevEvaluator({
    getApiKey: () => "test-only",
    fetch: async (_url, init) => {
      calls++;
      let bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      if (new Headers(init?.headers).get("content-encoding") === "zstd")
        bytes = zstdDecompressSync(bytes);
      body = JSON.parse(bytes.toString());
      return Response.json({
        model: "jev-concrete-version",
        answers: Object.fromEntries(
          candidates.map((c) => [c.id, { type: "noul", noul: 0.7 }]),
        ),
        usage: { input_tokens: 12, output_tokens: null },
      });
    },
  });
  const result = await evaluate({
    candidates,
    state,
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  assert.equal(calls, 1);
  assert.equal(result.model, "jev-concrete-version");
  assert.equal(result.usage.input_tokens, 12);
  const questions = body.questions as Record<string, { type: string }>;
  assert.equal(Object.keys(questions).length, 2);
  assert(Object.values(questions).every((q) => q.type === "noul"));
  assert.deepEqual(JSON.parse(body.state as string), state);
  assert.doesNotMatch(JSON.stringify(questions), /filePath|SKILL\.md/);
});

test("official SDK never retries authentication, rate limit, oversized or service errors", async () => {
  for (const [status, reason] of [
    [401, "authentication"],
    [429, "rate_limit"],
    [413, "input_limit"],
    [500, "service_error"],
    [451, "service_error"],
  ] as const) {
    let calls = 0;
    const evaluator = createJevEvaluator({
      getApiKey: () => "test-only",
      fetch: async () => {
        calls++;
        return Response.json(
          { error: "server payload must stay private" },
          { status },
        );
      },
    });
    await assert.rejects(
      evaluator({
        candidates: autoCandidates([skill("a")], []),
        state,
        signal: new AbortController().signal,
        timeoutMs: 1000,
      }),
      (error: unknown) =>
        error instanceof RoutingFailure &&
        error.code === reason &&
        !error.message.includes("private"),
    );
    assert.equal(calls, 1);
  }
});

test("missing key is an explicit failure and never calls transport", async () => {
  const evaluator = createJevEvaluator({
    getApiKey: () => "",
    fetch: async () => {
      throw new Error("Transport must not be called");
    },
  });
  await assert.rejects(
    evaluator({
      candidates: autoCandidates([skill("a")], []),
      state,
      signal: new AbortController().signal,
      timeoutMs: 1000,
    }),
    (error: unknown) =>
      error instanceof RoutingFailure && error.code === "missing_key",
  );
});

test("response validator rejects missing, extra, non-Noul and invalid probabilities", () => {
  const candidates = autoCandidates([skill("a")], []);
  const id = candidates[0]?.id;
  assert(id);
  const good = {
    model: "jev-test",
    usage: { input_tokens: null, output_tokens: null },
  };
  for (const answers of [
    {},
    {
      [id]: { type: "noul", noul: 1 },
      injected_path: { type: "noul", noul: 1 },
    },
    { [id]: { type: "noul", noul: NaN } },
    { [id]: { type: "noul", noul: 1.1 } },
    { [id]: { type: "noul", noul: "0.9" } },
    { [id]: { type: "choice", noul: 0.9 } },
  ]) {
    assert.throws(
      () => validateResponse({ ...good, answers }, candidates),
      (error: unknown) =>
        error instanceof RoutingFailure && error.code === "invalid_response",
    );
  }
});

test("total deadline covers an SDK response body that never finishes", async () => {
  let transportSignal: AbortSignal | undefined;
  const evaluate = createJevEvaluator({
    getApiKey: () => "test-only",
    fetch: async (_url, init) => {
      transportSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await route(
    {
      catalog: [skill("a")],
      pinned: [],
      state,
      config: { ...config, routeTimeoutMs: 30 },
      signal: undefined,
      issues: [],
    },
    evaluate,
  );
  assert.equal(result.report.status, "fallback");
  assert.equal(result.report.reason, "timeout");
  assert.equal(transportSignal?.aborted, true);
});
