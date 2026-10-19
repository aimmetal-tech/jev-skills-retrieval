import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  loadSkillsFromDir,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Budget } from "../benchmark/budget.ts";
import { ParallelCheckpoint } from "../benchmark/parallel/checkpoint.ts";
import { Coordinator } from "../benchmark/parallel/coordinator.ts";
import { rpc, serve, socketPath } from "../benchmark/parallel/ipc.ts";
import {
  type JobRecord,
  PARALLEL_LIMITS,
  type PhaseSpec,
  type RpcRequest,
} from "../benchmark/parallel/protocol.ts";
import { runPiTrial } from "../benchmark/pi.ts";
import type { Group } from "../benchmark/types.ts";
import { skillIdentity } from "../src/selection.ts";

test("six isolated real Pi sessions cross the provider boundary with per-group three and durable Responses accounting", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jev-parallel-pi-"));
  await mkdir(resolve(root, "skill"));
  const skillPath = resolve(root, "skill/SKILL.md");
  await writeFile(
    skillPath,
    "---\nname: test-skill\ndescription: Native safe fixture\n---\nSAFE_BODY\n",
  );
  const catalog = loadSkillsFromDir({
    dir: resolve(root, "skill"),
    source: "fixture",
  }).skills;
  let pi = 0,
    jev = 0,
    activePi = 0,
    peakPi = 0,
    activeJev = 0,
    peakJev = 0;
  let releaseFirstWave: () => void = () => {};
  const firstWave = new Promise<void>((done) => {
    releaseFirstWave = done;
  });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    if (req.url === "/v1/systemone") {
      jev++;
      activeJev++;
      peakJev = Math.max(peakJev, activeJev);
      await delay(20);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "jev-1.14.0",
          answers: Object.fromEntries(
            Object.keys(payload.questions).map((k) => [
              k,
              { type: "noul", noul: 0.9 },
            ]),
          ),
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
      activeJev--;
      return;
    }
    assert.equal(req.url, "/v1/responses");
    assert.equal(payload.model, "gpt-6-luna");
    assert.equal(payload.reasoning.effort, "medium");
    pi++;
    const index = pi;
    activePi++;
    peakPi = Math.max(peakPi, activePi);
    if (index === 6) releaseFirstWave();
    if (index <= 6) await firstWave;
    await delay(120);
    const tool = !payload.input.some(
      (x: { type: string }) => x.type === "function_call_output",
    );
    const item = tool
      ? {
          type: "function_call",
          id: `fc${index}`,
          call_id: `call${index}`,
          name: "read",
          arguments: JSON.stringify({ path: skillPath }),
          status: "completed",
        }
      : {
          type: "message",
          id: `msg${index}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Done.", annotations: [] }],
        };
    const response = {
      id: `resp${index}`,
      object: "response",
      model: "gpt-6-luna",
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 100,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    };
    res.setHeader("content-type", "text/event-stream");
    const emit = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    emit({
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    });
    emit({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, ...(tool ? { arguments: "" } : { content: [] }) },
    });
    if (tool)
      emit({
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: 0,
        delta: JSON.stringify({ path: skillPath }),
      });
    else {
      emit({
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      emit({
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "Done.",
      });
    }
    emit({ type: "response.output_item.done", output_index: 0, item });
    emit({ type: "response.completed", response });
    res.end();
    activePi--;
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const spec: PhaseSpec = {
    version: 3,
    id: "six-session",
    fingerprint: "fixture",
    concurrency: 3,
    queryIds: ["q1", "q2", "q3"],
    kind: "calibration",
    maxRequests: 100,
    maxTotalTokens: 100000,
    evidence: "mock",
  };
  const coordinator = new Coordinator(resolve(root, "coordinator"), spec);
  const ipc = await serve(socketPath(root), (r) => coordinator.handle(r));
  const epochs = { native: 0, router: 0 };
  for (const group of ["native", "router"] as Group[])
    epochs[group] = Number(
      (
        await rpc(socketPath(root), {
          op: "register",
          phase: spec.id,
          group,
          pid: process.pid,
        })
      ).epoch,
    );
  try {
    const jobs = await Promise.all(
      (["native", "router"] as Group[]).flatMap((group) =>
        Array.from({ length: 3 }, async () => {
          const call = (r: RpcRequest, signal?: AbortSignal) =>
            rpc(
              socketPath(root),
              { ...r, phase: spec.id, group, epoch: epochs[group] },
              signal,
            );
          const job = (await call({ op: "next" })).job as JobRecord;
          const dir = resolve(root, group, job.caseId);
          await mkdir(dir, { recursive: true });
          const runtime = await ModelRuntime.create({
            authPath: resolve(dir, "fake-auth.json"),
            modelsPath: null,
            refreshOnCreate: false,
          });
          runtime.registerProvider("openai", {
            api: "openai-responses",
            baseUrl: `${base}/v1`,
            apiKey: "fake-only",
            models: [
              {
                id: "gpt-6-luna",
                name: "fixture",
                reasoning: true,
                input: ["text"],
                contextWindow: 272000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          });
          runtime.isUsingOAuth = () => true;
          const cp = new ParallelCheckpoint(
            resolve(dir, "checkpoint"),
            `${group}-${job.caseId}`,
            job,
            call,
          );
          await cp.initialize();
          try {
            const row = await runPiTrial({
              suite: "skillret",
              caseId: job.caseId,
              group,
              prompt: `Read the fixture for ${job.caseId}`,
              gold: ["skill"],
              catalog,
              ids: new Map([[skillIdentity(skillPath), "skill"]]),
              cwd: dir,
              agentDir: resolve(dir, "agent"),
              model: "gpt-6-luna",
              nativeOAuth: true,
              nativeRuntime: runtime,
              budget: new Budget(PARALLEL_LIMITS, true),
              evidence: "mock",
              durability: cp,
              checkpoint: resolve(dir, "partial.json"),
              routerConfig: {
                baseUrl: base,
                routeTimeoutMs: 3600000,
                evaluationTimeoutMs: 3600000,
                batchTimeoutMs: 3600000,
              },
              routerDependencies: {
                getApiKey: () => "fake-jev-only",
                onRouteStart: () => cp.routing(true),
                onReport: () => cp.routing(false),
              },
            });
            assert.equal(row.status, "completed");
            assert.equal(row.pi.total, 216);
            assert.equal(row.pi.complete, true);
            assert.equal(row.pi.reasoning, 4);
            assert.equal(row.requests.pi, 2);
            assert.equal(row.reads.length, 1);
            assert.equal(row.jev.total, group === "router" ? 12 : 0);
            await call({ op: "complete", job: job.key, row });
            return row;
          } finally {
            cp.close();
          }
        }),
      ),
    );
    assert.equal(jobs.length, 6);
    assert.equal(pi, 12);
    assert.equal(jev, 3);
    assert.equal(peakPi, 6);
    assert(peakJev <= 3);
    assert.equal(coordinator.rows().length, 6);
    assert.equal(coordinator.knownTokens, 6 * 216 + 3 * 12);
  } finally {
    await new Promise<void>((done) => ipc.close(() => done()));
    coordinator.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
