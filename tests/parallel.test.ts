import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { ParallelCheckpoint } from "../benchmark/parallel/checkpoint.ts";
import { Coordinator } from "../benchmark/parallel/coordinator.ts";
import { rpc, serve, socketPath } from "../benchmark/parallel/ipc.ts";
import {
  type AttemptRecord,
  type JobRecord,
  type PhaseSpec,
  POLICY,
  type RpcRequest,
  selectQueries,
} from "../benchmark/parallel/protocol.ts";
import { selectConcurrency } from "../benchmark/parallel/reporting.ts";
import { TrialClock } from "../benchmark/parallel/timing.ts";
import { emptyCounts, type Group } from "../benchmark/types.ts";

const spec: PhaseSpec = {
  version: 3,
  id: "fixture-v3",
  fingerprint: "fake-fingerprint",
  concurrency: 3,
  queryIds: ["q1", "q2", "q3", "q4"],
  kind: "calibration",
  maxRequests: 100,
  maxTotalTokens: 10000,
  evidence: "mock",
};
const usage = { ...emptyCounts(), input: 10, output: 2, total: 12 };
async function fixture(overrides: Partial<PhaseSpec> = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "jev-parallel-test-"));
  const c = new Coordinator(root, { ...spec, ...overrides });
  const server = await serve(socketPath(root), (r) => c.handle(r));
  const epochs = { native: 0, router: 0 };
  for (const group of ["native", "router"] as Group[])
    epochs[group] = Number(
      (
        await rpc(socketPath(root), {
          op: "register",
          phase: c.spec.id,
          group,
          pid: process.pid,
        })
      ).epoch,
    );
  const call = (group: Group) => (r: RpcRequest, signal?: AbortSignal) =>
    rpc(
      socketPath(root),
      { ...r, phase: c.spec.id, group, epoch: epochs[group] },
      signal,
    );
  return {
    root,
    c,
    call,
    async close() {
      await new Promise<void>((done) => server.close(() => done()));
      c.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("IPC enforces three jobs per group, permits six Pi requests total, and shares budgets", async () => {
  const f = await fixture({ maxRequests: 6 });
  try {
    const ids: string[] = [];
    for (const group of ["native", "router"] as Group[])
      for (let i = 0; i < 3; i++) {
        const job = (await f.call(group)({ op: "next" })).job as JobRecord;
        const id = randomUUID();
        ids.push(id);
        assert.equal(
          (
            await f.call(group)({
              op: "admit",
              job: job.key,
              provider: "pi",
              requestKey: `${job.key}/pi/1-abcdef`,
              id,
            })
          ).granted,
          true,
        );
      }
    assert.equal(f.c.attempts.size, 6);
    assert.equal((await f.call("native")({ op: "next" })).job, undefined);
    const a = f.c.attempts.get(ids[0] as string) as AttemptRecord;
    await f.call("native")({ op: "settle", id: a.id, status: 200, usage });
    await f.call("native")({ op: "settle", id: a.id, status: 200, usage });
    assert.equal(f.c.knownTokens, 12);
    const blocked = await f.call("native")({
      op: "admit",
      job: a.job,
      provider: "pi",
      requestKey: `${a.job}/pi/2-abcdef`,
      id: randomUUID(),
    });
    assert.equal(blocked.paused, "shared_budget_limit");
    assert.equal(f.c.attempts.size, 6);
  } finally {
    await f.close();
  }
});
test("provider cooldown is shared, Pi pauses both groups, Jev pauses only router", async () => {
  const f = await fixture();
  try {
    const native = (await f.call("native")({ op: "next" })).job as JobRecord;
    const router = (await f.call("router")({ op: "next" })).job as JobRecord;
    await f.call("native")({
      op: "cooldown",
      provider: "pi",
      until: Date.now() + 10000,
    });
    const reply = await f.call("router")({
      op: "admit",
      job: router.key,
      provider: "pi",
      requestKey: `${router.key}/pi/1-x`,
      id: randomUUID(),
    });
    assert.equal(reply.waiting, "cooldown");
    assert.equal(f.c.attempts.size, 0);
    f.c.pause("jev", "retry_exhausted", "router/q1/jev/1-x");
    assert.equal(
      (await f.call("router")({ op: "next" })).paused,
      "provider_paused",
    );
    assert((await f.call("native")({ op: "next" })).job);
    f.c.pause("pi", "retry_exhausted", `${native.key}/pi/1-x`);
    assert.equal(
      (await f.call("native")({ op: "next" })).paused,
      "provider_paused",
    );
  } finally {
    await f.close();
  }
});
test("six actual failures persist, ordinary replay cannot reset them, manual cycle preserves unknown costs", async () => {
  const f = await fixture();
  const fast = { ...POLICY, backoffMs: [1, 2, 3, 4, 5], jitter: 0 };
  try {
    const job = (await f.call("router")({ op: "next" })).job as JobRecord;
    const dir = resolve(f.root, "trial");
    let calls = 0;
    const first = new ParallelCheckpoint(
      dir,
      "scope",
      job,
      f.call("router"),
      () => 0,
      fast,
    );
    await first.initialize();
    const request = {
      method: "POST",
      headers: { authorization: "Bearer fake-private-key" },
      body: '{"query":"public"}',
    };
    await assert.rejects(
      () =>
        first.fetch("jev", async () => {
          calls++;
          return Response.json({}, { status: 529 });
        })("http://fixture.invalid", request),
      /exhausted/,
    );
    first.close();
    assert.equal(calls, 6);
    assert.equal(f.c.unknownRequests, 6);
    const restarted = new ParallelCheckpoint(
      dir,
      "scope",
      job,
      f.call("router"),
      () => 0,
      fast,
    );
    await restarted.initialize();
    await assert.rejects(
      () =>
        restarted.fetch("jev", async () => {
          calls++;
          return Response.json({});
        })("http://fixture.invalid", request),
      /exhausted/,
    );
    restarted.close();
    assert.equal(calls, 6);
    assert.throws(() => f.c.resume("jev", false), /authorization/);
    f.c.resume("jev", true);
    const manually = new ParallelCheckpoint(
      dir,
      "scope",
      job,
      f.call("router"),
      () => 0,
      fast,
    );
    await manually.initialize();
    const answer = await manually.fetch("jev", async () => {
      calls++;
      return Response.json({
        model: "fixture",
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    })("http://fixture.invalid", request);
    assert.equal(answer.status, 200);
    manually.close();
    assert.equal(calls, 7);
    assert.equal(f.c.knownTokens, 12);
    assert.equal(f.c.unknownRequests, 6);
    assert.equal(manually.stats().jev.complete, false);
    assert.doesNotMatch(
      await readFile(resolve(dir, "jev-000001.json"), "utf8"),
      /fake-private-key|authorization/,
    );
  } finally {
    await f.close();
  }
});
test("durable real responses replay without HTTP or double charge, mismatched inputs fail closed", async () => {
  const f = await fixture();
  try {
    const job = (await f.call("native")({ op: "next" })).job as JobRecord,
      dir = resolve(f.root, "trial");
    const first = new ParallelCheckpoint(dir, "scope", job, f.call("native"));
    await first.initialize();
    const init = {
      method: "POST",
      body: '{"model":"fixture","prompt_cache_key":"first"}',
    };
    await first.fetch("pi", async () =>
      Response.json({ usage: { input_tokens: 10, output_tokens: 2 } }),
    )("http://fixture.invalid", init);
    first.close();
    const second = new ParallelCheckpoint(dir, "scope", job, f.call("native"));
    await second.initialize();
    await second.fetch("pi", async () => {
      throw new Error("No network");
    })("http://fixture.invalid", {
      ...init,
      body: '{"model":"fixture","prompt_cache_key":"second"}',
    });
    assert.equal(second.stats().replayed.pi, 1);
    assert.equal(f.c.attempts.size, 1);
    assert.equal(f.c.knownTokens, 12);
    second.close();
    const mismatch = new ParallelCheckpoint(
      dir,
      "scope",
      job,
      f.call("native"),
    );
    await mismatch.initialize();
    await assert.rejects(
      () =>
        mismatch.fetch("pi", async () => Response.json({}))(
          "http://fixture.invalid",
          { ...init, body: '{"model":"changed"}' },
        ),
      /mismatch/,
    );
    mismatch.close();
  } finally {
    await f.close();
  }
});
test("work, queue, backoff and cooldown clocks are disjoint; offline does not erase accrued time", () => {
  let now = 0;
  const clock = new TrialClock(undefined, () => now);
  clock.routing(true);
  now = 10;
  clock.set("queue");
  now = 30;
  clock.set("backoff");
  now = 60;
  clock.set("cooldown");
  now = 100;
  clock.set("work");
  now = 120;
  const state = clock.snapshot();
  assert.equal(state.onlineMs, 120);
  assert.equal(state.workMs, 30);
  assert.equal(state.routeWorkMs, 30);
  assert.equal(state.queueMs, 20);
  assert.equal(state.backoffMs, 30);
  assert.equal(state.cooldownMs, 40);
  now = 10000;
  const restored = new TrialClock(state, () => now);
  now += 5;
  assert.equal(restored.snapshot().onlineMs, 125);
  assert.equal(restored.state.resumes, 1);
});

test("coordinator restart retains the durable ledger, repairs only torn tails, and refuses traffic while workers are alive", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jev-parallel-restart-"));
  let c: Coordinator | undefined;
  try {
    c = new Coordinator(root, spec);
    for (const group of ["native", "router"] as Group[])
      c.handle({ op: "register", phase: spec.id, group, pid: process.pid });
    const call = (r: RpcRequest) =>
      c?.handle({ ...r, phase: spec.id, group: "native", epoch: 1 });
    const job = call({ op: "next" })?.job as JobRecord;
    const id = randomUUID();
    call({
      op: "admit",
      job: job.key,
      provider: "pi",
      requestKey: `${job.key}/pi/1-x`,
      id,
    });
    call({ op: "settle", id, status: 200, usage });
    c.close();
    c = undefined;
    await appendFile(resolve(root, "coordinator.jsonl"), '{"torn":');
    c = new Coordinator(root, spec);
    assert.equal(c.knownTokens, 12);
    assert.equal(c.attempts.size, 1);
    assert.equal(c.recovered, true);
    assert.equal(
      call({
        op: "admit",
        job: job.key,
        provider: "pi",
        requestKey: `${job.key}/pi/2-x`,
        id: randomUUID(),
      })?.paused,
      "coordinator_restarted_requires_manual_recovery",
    );
    assert.throws(() => c?.recoverInfrastructure(), /stop_workers/);
    const before = c.jobs.get(job.key) as JobRecord;
    c.handle({
      op: "job-paused",
      phase: spec.id,
      group: "native",
      epoch: 1,
      job: job.key,
      reason: "time:task_work",
    });
    c.extend(job.key, 60000, 0, 60000);
    assert.equal(c.jobs.get(job.key)?.extraWorkMs, before.extraWorkMs + 60000);
    assert(c.manualInterventions > 0);
  } finally {
    c?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("calibration samples are fixed without qrels, and five must improve eligible throughput by 20 percent", () => {
  const q = Array.from({ length: 100 }, (_, i) => ({
    id: `q${i}`,
    query: "x".repeat(i + 1),
  }));
  assert.deepEqual(selectQueries(q), selectQueries([...q].reverse()));
  assert.equal(new Set(selectQueries(q).map((x) => x.id)).size, 20);
  const three = {
    eligible: true,
    elapsedMs: 100,
    throughputPerHour: 100,
    rateLimitedFraction: 0,
    rows: 40,
    recovered: false,
  };
  assert.equal(
    selectConcurrency(three, { ...three, throughputPerHour: 119 }),
    3,
  );
  assert.equal(
    selectConcurrency(three, { ...three, throughputPerHour: 120 }),
    5,
  );
  assert.equal(
    selectConcurrency(three, {
      ...three,
      eligible: false,
      throughputPerHour: 200,
    }),
    3,
  );
  assert.equal(selectConcurrency({ ...three, eligible: false }, three), null);
});
