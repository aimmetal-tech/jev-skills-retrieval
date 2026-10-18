import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { Budget } from "../benchmark/budget.ts";
import { retrieval, summarizeTrials } from "../benchmark/metrics.ts";
import { runPiTrial } from "../benchmark/pi.ts";
import { sandboxPath, shellQuote } from "../benchmark/remote.ts";
import { readLimits, writeReport } from "../benchmark/run.ts";
import { emptyCounts, type Group, type Trial } from "../benchmark/types.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { skillIdentity } from "../src/selection.ts";

const limits = {
  maxRequests: 10,
  maxTotalTokens: 10000,
  maxTurns: 5,
  maxOutputTokens: 200,
  taskTimeoutMs: 10000,
};

test("benchmark metrics count failed attempts and Jev overhead, retain unknowns and penalize fallback", () => {
  const row: Trial = {
    schemaVersion: 1,
    suite: "skillsbench",
    caseId: "one",
    group: "router",
    evidence: "mock",
    model: "mock",
    responseModels: [],
    status: "completed",
    httpStatus: 200,
    elapsedMs: 10,
    catalogCount: 2,
    selectedIds: ["gold", "noise"],
    reads: [{ id: "gold", offset: 1, limit: null, truncated: false }],
    relevantIds: ["gold"],
    routeReports: [
      { status: "fallback", candidateCount: 2, selectedCount: 2, elapsedMs: 1 },
    ],
    pi: { ...emptyCounts(), total: 100 },
    jev: { ...emptyCounts(), total: 10 },
    requests: { pi: 1, jev: 1 },
    taskSuccess: true,
    verifierStatus: "passed",
  };
  const failed = {
    ...row,
    caseId: "two",
    taskSuccess: false,
    status: "timeout" as const,
  };
  const summary = summarizeTrials([row, failed], { skillsbench: 3 }).find(
    (r) => r.suite === "skillsbench" && r.group === "router",
  );
  assert.equal(summary?.tokensPerSuccess, 220);
  assert.equal(summary?.routeF1, 0);
  assert.equal(summary?.coverage, 2 / 3);
  assert.equal(summary?.successRate, 0.5);
  row.pi.complete = false;
  assert.equal(
    summarizeTrials([row], {}).find(
      (r) => r.group === "router" && r.suite === "skillsbench",
    )?.totalTokens,
    null,
  );
  assert.deepEqual(retrieval(["gold", "gold", "noise"], ["gold"]), {
    precision: 0.5,
    recall: 1,
    f1: 2 / 3,
    complete: true,
    hits: 1,
    predicted: 2,
    relevant: 1,
  });
});

test("live requires explicit positive budgets; transport cap blocks before HTTP", async () => {
  assert.throws(() => readLimits({}), /max-requests/);
  const budget = new Budget({ ...limits, maxRequests: 1 });
  let calls = 0;
  const transport = budget.fetch(async () => {
    calls++;
    return Response.json({});
  });
  await transport("http://unused.invalid");
  await assert.rejects(
    () => transport("http://unused.invalid"),
    /budget_stopped/,
  );
  assert.equal(calls, 1);
  assert.equal(budget.requests, 1);
});

async function boundary(
  group: Group,
  requestCap = 10,
  usage = true,
  forbidden = false,
) {
  const root = await mkdtemp(resolve(tmpdir(), "jev-benchmark-"));
  const payloads: string[] = [];
  let piCalls = 0;
  let jevCalls = 0;
  for (const name of ["alpha", "beta"]) {
    await mkdir(resolve(root, "skills", name), { recursive: true });
    await writeFile(
      resolve(root, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: UNIQUE_${name.toUpperCase()} metadata\n---\nBODY_${name.toUpperCase()}\n`,
    );
  }
  await writeFile(resolve(root, "gold-labels.json"), "HIDDEN_GOLD_SECRET");
  const path = forbidden
    ? resolve(root, "gold-labels.json")
    : resolve(root, "skills/alpha/SKILL.md");
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/v1/systemone") {
      jevCalls++;
      const input = JSON.parse(body);
      assert.equal(input.model, "jev-1.14.0");
      const answers = Object.fromEntries(
        Object.entries(input.questions).map(([id, value]) => [
          id,
          {
            type: "noul",
            noul: JSON.stringify(value).includes("alpha") ? 0.9 : 0.1,
          },
        ]),
      );
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          model: "jev-mock-response",
          answers,
          usage: { input_tokens: 20, output_tokens: 2 },
        }),
      );
      return;
    }
    piCalls++;
    payloads.push(body);
    const input = JSON.parse(body);
    assert.equal(input.model, "openai-gpt-6-luna");
    assert.equal(input.reasoning_effort, "none");
    res.setHeader("Content-Type", "text/event-stream");
    const toolCall = piCalls === 1;
    const delta = toolCall
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "read1",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path }) },
            },
          ],
        }
      : { role: "assistant", content: "Done." };
    for (const [patch, finish] of [
      [delta, null],
      [{}, toolCall ? "tool_calls" : "stop"],
    ]) {
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "mock-response", choices: [{ index: 0, delta: patch, finish_reason: finish }] })}\n\n`,
      );
    }
    if (usage)
      res.write(
        `data: ${JSON.stringify({ id: "fixture", model: "mock-response", choices: [], usage: { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const catalog = loadSkillsFromDir({
    dir: resolve(root, "skills"),
    source: "isolated-benchmark-test",
  }).skills;
  const budget = new Budget({ ...limits, maxRequests: requestCap });
  try {
    const checkpoint = resolve(root, "partial.json");
    const row = await runPiTrial({
      suite: "skillret",
      caseId: "fixture",
      group,
      prompt: "Please use alpha",
      gold: ["alpha"],
      catalog,
      ids: new Map(catalog.map((s) => [skillIdentity(s.filePath), s.name])),
      cwd: root,
      agentDir: resolve(root, "agent"),
      model: "openai-gpt-6-luna",
      baseUrl: `${baseUrl}/v1`,
      apiKey: "fake-benchmark-only",
      evidence: "mock",
      budget,
      checkpoint,
      routerDependencies: {
        getApiKey: () => "fake-jev-only",
        configuration: () => ({
          config: { ...DEFAULT_CONFIG, pinnedSkillPaths: [], baseUrl },
          issues: [],
        }),
      },
    });
    const partial = JSON.parse(await readFile(checkpoint, "utf8"));
    assert.equal(partial.caseId, "fixture");
    return { row, payloads, piCalls, jevCalls, budget };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((err) => (err ? reject(err) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
}

test("benchmark launches real Pi with and without plugin; captures wire prompts, reads and disjoint usage", async () => {
  for (const group of ["native", "router"] as const) {
    const result = await boundary(group);
    assert.equal(result.row.status, "completed");
    assert.equal(result.row.catalogCount, 2);
    assert.equal(result.piCalls, 2);
    assert.equal(result.jevCalls, group === "router" ? 1 : 0);
    assert.deepEqual(
      result.row.reads.map((r) => r.id),
      ["alpha"],
    );
    assert.equal(result.row.pi.total, 216);
    assert.equal(result.row.pi.reasoning, 4);
    assert.equal(result.row.pi.cacheRead, 20);
    assert.equal(result.row.pi.complete, true);
    assert.equal(result.row.jev.total, group === "router" ? 22 : 0);
    assert.match(result.payloads[0] ?? "", /UNIQUE_ALPHA/);
    if (group === "router")
      assert.doesNotMatch(result.payloads[0] ?? "", /UNIQUE_BETA/);
    else assert.match(result.payloads[0] ?? "", /UNIQUE_BETA/);
    assert.doesNotMatch(result.payloads[0] ?? "", /BODY_ALPHA/);
    assert.match(result.payloads[1] ?? "", /BODY_ALPHA/);
    assert.deepEqual(result.row.responseModels, ["mock-response"]);
  }
});

test("Pi continuation is stopped by the HTTP cap, missing usage stays unknown, and labels cannot be read", async () => {
  const capped = await boundary("native", 1);
  assert.equal(capped.piCalls, 1);
  assert.equal(capped.row.requests.pi, 1);
  assert.notEqual(capped.row.status, "completed");
  const unknown = await boundary("native", 10, false);
  assert.equal(unknown.piCalls, 1);
  assert.equal(unknown.row.pi.complete, false);
  const forbidden = await boundary("native", 10, true, true);
  assert.equal(forbidden.row.reads.length, 0);
  assert.doesNotMatch(forbidden.payloads.join("\n"), /HIDDEN_GOLD_SECRET/);
});

test("sandbox namespace mapping and shell quoting do not execute text locally", () => {
  const root = resolve(".tmp/virtual-root");
  assert.equal(
    sandboxPath(root, resolve(root, "app/my file.txt")),
    "/app/my file.txt",
  );
  assert.equal(shellQuote("a'$(echo nope)"), "'a'\\''$(echo nope)'");
});

test("empty and mock reports cannot be presented as live performance", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jev-benchmark-report-"));
  try {
    const report = await writeReport(
      root,
      [],
      { skillret: 4392, skillsbench: 87 },
      false,
    );
    assert.equal(report.evidence, "no-live-results");
    assert.equal(report.groups[0]?.readF1, null);
    assert.equal(report.groups[0]?.coverage, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
