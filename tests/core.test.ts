import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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
  pinnedSkills,
  prepareCatalog,
  selectAutomatic,
  skillIdentity,
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

test("a full request resolves each path once and reuses candidate IDs through selection and fallback", async () => {
  const skills = Array.from({ length: 6006 }, (_, i) => skill(`item-${i}`));
  let calls = 0;
  const prepared = prepareCatalog([...skills, skills[0] as Skill], {
    identity: (path) => {
      calls++;
      return path;
    },
  });
  assert.equal(calls, 6006);
  assert.equal(prepared.catalog.length, 6006);
  assert.equal(prepared.candidates.length, 6006);
  const before = prepared.candidates.map((c) => c.id);
  const request = {
    catalog: skills,
    pinned: [],
    prepared,
    state,
    config,
    signal: undefined,
    issues: [],
  };
  const success = await route(request, async ({ candidates }) => {
    assert.equal(candidates, prepared.candidates);
    return {
      probabilities: { [candidates[0]?.id as string]: 0.9 },
      model: "test",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });
  assert.deepEqual(success.skills, [skills[0]]);
  const failure = await route(request, async () => {
    throw new RoutingFailure("service_error", "test failure");
  });
  assert.equal(failure.report.status, "fallback");
  assert.deepEqual(failure.skills, skills);
  assert.deepEqual(
    prepared.candidates.map((c) => c.id),
    before,
  );
  assert.equal(calls, 6006);
  pinnedSkills(skills, [], () => {
    throw new Error("Empty pins must not build an index");
  });
});

test("snapshots preserve real path aliases, pinned clones and fresh identities on the next request", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-snapshot-"));
  try {
    const one = join(root, "one");
    const two = join(root, "two");
    const alias = join(root, "alias");
    await mkdir(one);
    await mkdir(two);
    await writeFile(join(one, "SKILL.md"), "one");
    await writeFile(join(two, "SKILL.md"), "two");
    await symlink(one, alias, "junction");
    const original = {
      ...skill("one", one),
      filePath: join(one, "SKILL.md"),
      disableModelInvocation: true,
    };
    const aliased = { ...original, filePath: join(alias, "SKILL.md") };
    const other = { ...skill("two", two), filePath: join(two, "SKILL.md") };
    const first = prepareCatalog([original, aliased, other], {
      pinnedPaths: [aliased.filePath],
    });
    assert.deepEqual(first.catalog, [original, other]);
    assert.equal(first.pinned[0]?.disableModelInvocation, false);
    assert.equal(original.disableModelInvocation, true);
    assert.deepEqual(
      first.candidates.map((c) => c.skill),
      [other],
    );
    assert.equal(first.candidates[0]?.id, autoCandidates([other], [])[0]?.id);
    const old = skillIdentity(aliased.filePath);
    await unlink(alias);
    await symlink(two, alias, "junction");
    const second = prepareCatalog([original, aliased, other]);
    assert.notEqual(skillIdentity(aliased.filePath), old);
    assert.deepEqual(second.catalog, [original, aliased]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preparation consumes the total deadline and pre-aborted routing skips catalog access", async () => {
  let evaluations = 0;
  const prepared = prepareCatalog([skill("one")]);
  const result = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      preparationMs: 21,
      state,
      config: { ...config, routeTimeoutMs: 20 },
      signal: undefined,
      issues: [],
    },
    async () => {
      evaluations++;
      throw new Error("Deadline already consumed");
    },
  );
  assert.equal(result.report.reason, "timeout");
  assert.equal(result.report.timings?.evaluationMs, 0);
  assert((result.report.timings?.preparationMs ?? 0) >= 21);
  const cancelled = await route(
    {
      get catalog(): Skill[] {
        throw new Error("Must not inspect catalog");
      },
      pinned: [],
      state,
      config,
      signal: AbortSignal.abort(),
      issues: [],
    },
    async () => {
      throw new Error("Must not evaluate");
    },
  );
  assert.equal(cancelled.report.status, "cancelled");
  assert.equal(evaluations, 0);
});

test("preparation and evaluation caps remain independent under a tighter total deadline", async () => {
  const prepared = prepareCatalog([skill("one")]);
  const request = {
    catalog: prepared.catalog,
    pinned: [],
    prepared,
    state,
    config,
    signal: undefined,
    issues: [],
  };
  let calls = 0;
  const local = await route(
    {
      ...request,
      preparationMs: 51,
      config: { ...config, preparationTimeoutMs: 50 },
    },
    async () => {
      calls++;
      throw new Error("Must not reach evaluator");
    },
  );
  assert.equal(local.report.timeoutPhase, "preparation");
  assert.equal(calls, 0);
  let abort: AbortSignal | undefined;
  const remote = await route(
    {
      ...request,
      config: { ...config, routeTimeoutMs: 200, evaluationTimeoutMs: 20 },
    },
    async (r) => {
      assert(r.timeoutMs <= 20);
      abort = r.signal;
      return new Promise(() => {});
    },
  );
  assert.equal(remote.report.timeoutPhase, "evaluation");
  assert.equal(abort?.aborted, true);
  assert((remote.report.timings?.evaluationMs ?? 0) >= 10);
  const total = await route(
    {
      ...request,
      preparationMs: 25,
      config: { ...config, routeTimeoutMs: 40, evaluationTimeoutMs: 200 },
    },
    async (r) => {
      assert(r.timeoutMs <= 15);
      return new Promise(() => {});
    },
  );
  assert.equal(total.report.timeoutPhase, "total");
  assert.equal(total.report.reason, "timeout");
});

test("synchronous SDK construction cannot accept a result after its evaluation deadline", async () => {
  let signal: AbortSignal | undefined;
  const result = await route(
    {
      catalog: [skill("one")],
      pinned: [],
      state,
      config: { ...config, evaluationTimeoutMs: 5 },
      signal: undefined,
      issues: [],
    },
    async (request) => {
      signal = request.signal;
      const end = performance.now() + 15;
      while (performance.now() < end) {
        /* Simulate synchronous SDK work. */
      }
      return {
        probabilities: {},
        model: "late",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  );
  assert.equal(result.report.timeoutPhase, "evaluation");
  assert.equal(result.report.status, "fallback");
  assert.equal(signal?.aborted, true);
  assert.deepEqual(result.report.usage, { input_tokens: 1, output_tokens: 1 });
});

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
    assert.equal(loadConfig(root, agent).config.model, "jev-1.14.0");
    await writeFile(
      join(agent, "skill-router.json"),
      JSON.stringify({
        minProbability: 0.7,
        maxAutoSkills: 2,
        model: "jev-user-override",
        pinnedSkillPaths: ["../shared/SKILL.md"],
      }),
    );
    await writeFile(
      join(root, ".pi/skill-router.json"),
      JSON.stringify({
        minProbability: 0.8,
        model: "jev-project-override",
        preparationTimeoutMs: 7000,
        evaluationTimeoutMs: 8000,
        pinnedSkillPaths: ["../shared/SKILL.md", "./skills/x/SKILL.md"],
      }),
    );
    const loaded = loadConfig(root, agent);
    assert.deepEqual(loaded.issues, []);
    assert.equal(loaded.config.minProbability, 0.8);
    assert.equal(loaded.config.maxAutoSkills, 2);
    assert.equal(loaded.config.model, "jev-project-override");
    assert.equal(loaded.config.preparationTimeoutMs, 7000);
    assert.equal(loaded.config.evaluationTimeoutMs, 8000);
    assert.deepEqual(loaded.config.pinnedSkillPaths, [
      join(root, "shared/SKILL.md"),
      join(root, ".pi/skills/x/SKILL.md"),
    ]);
    await writeFile(
      join(root, ".pi/skill-router.json"),
      JSON.stringify({
        routeTimeoutMs: -1,
        preparationTimeoutMs: 0,
        evaluationTimeoutMs: 2147483648,
        minProbability: 2,
        pinnedSkillPaths: ["./skills/x/SKILL.md", null],
        apiKey: "must-not-echo",
      }),
    );
    const invalid = loadConfig(root, agent);
    assert.equal(invalid.issues.length, 6);
    assert.equal(
      invalid.config.preparationTimeoutMs,
      DEFAULT_CONFIG.preparationTimeoutMs,
    );
    assert.equal(
      invalid.config.evaluationTimeoutMs,
      DEFAULT_CONFIG.evaluationTimeoutMs,
    );
    assert.equal(invalid.config.pinnedSkillPaths.length, 2);
    assert.equal(invalid.config.model, "jev-user-override");
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

test("routing pins the default model in the actual SDK payload and records the returned version", async () => {
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
  const result = await route(
    {
      catalog: candidates.map((candidate) => candidate.skill),
      pinned: [],
      state,
      config,
      signal: undefined,
      issues: [],
    },
    evaluate,
  );
  assert.equal(calls, 1);
  assert.equal(body.model, "jev-1.14.0");
  assert.equal(result.report.model, "jev-concrete-version");
  assert.equal(result.report.usage?.input_tokens, 12);
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

test("SDK token context rejection is reported precisely without forwarding arbitrary error data", async () => {
  for (const errorType of ["max_tokens_exceeded", "secret-unknown-error"]) {
    let calls = 0;
    const result = await route(
      {
        catalog: [skill("one")],
        pinned: [],
        state,
        config,
        signal: undefined,
        issues: [],
      },
      createJevEvaluator({
        getApiKey: () => "test-only",
        fetch: async () => {
          calls++;
          return Response.json(
            {
              detail: {
                error_type: errorType,
                message: "private-error-payload",
              },
            },
            { status: 400 },
          );
        },
      }),
    );
    assert.equal(calls, 1);
    assert.equal(result.report.reason, "input_limit");
    assert.equal(result.report.httpStatus, 400);
    assert.equal(
      result.report.serviceErrorType,
      errorType === "max_tokens_exceeded" ? errorType : undefined,
    );
    assert.doesNotMatch(
      JSON.stringify(result.report),
      /private-error-payload|secret-unknown-error/,
    );
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
