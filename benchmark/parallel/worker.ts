import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Budget } from "../budget.ts";
import { atomicJson } from "../checkpoint.ts";
import { loadSkillret } from "../data.ts";
import { mappingIds, runPiTrial } from "../pi.ts";
import { PERSISTENT_ROUTER_CONFIG } from "../profile.ts";
import { acquireRunLock } from "../recovery.ts";
import { createBenchmarkTransport } from "../transport.ts";
import type { Group, Trial } from "../types.ts";
import { ParallelCheckpoint } from "./checkpoint.ts";
import { rpc, socketPath } from "./ipc.ts";
import {
  digest,
  type JobRecord,
  PARALLEL_LIMITS,
  type PhaseSpec,
  type RpcReply,
  type RpcRequest,
} from "./protocol.ts";

const project = resolve(import.meta.dirname, "../..");
export async function worker(root: string, group: Group) {
  const path = socketPath(root),
    loaded = await loadSkillret(resolve(project, "outputs/benchmark/data"));
  const ids = mappingIds(loaded.catalog, loaded.byFile),
    queries = new Map(loaded.queries.map((q) => [q.id, q]));
  const transport = createBenchmarkTransport(),
    original = globalThis.fetch;
  globalThis.fetch = transport.fetch;
  let lastPhase = "";
  let stopRequested = false,
    watching = false;
  const active = new Set<ParallelCheckpoint>();
  const watcher = setInterval(() => {
    if (watching) return;
    watching = true;
    void rpc(path, { op: "phase" })
      .then((state) => {
        if (state.stopped || state.finished) {
          stopRequested = true;
          for (const c of active) c.pause("operator:stop");
        }
      })
      .catch(() => {
        for (const c of active)
          c.pause("infrastructure:coordinator_unavailable");
      })
      .finally(() => {
        watching = false;
      });
  }, 1000);
  try {
    for (;;) {
      if (stopRequested) return;
      let phase: RpcReply;
      try {
        phase = await rpc(path, { op: "phase" });
      } catch {
        console.error(
          "Coordinator unavailable; no provider requests are permitted.",
        );
        await delay(2000);
        continue;
      }
      if (phase.finished || phase.stopped) return;
      if (
        !phase.spec ||
        phase.blocked ||
        (phase.spec && (phase.spec as PhaseSpec).id === lastPhase)
      ) {
        await delay(1000);
        continue;
      }
      const spec = phase.spec as PhaseSpec,
        directory = String(phase.directory);
      if (
        spec.version !== 3 ||
        spec.evidence !== "live" ||
        !spec.queryIds.every((id) => queries.has(id))
      )
        throw new Error("worker_phase_invalid");
      const { fingerprint } = await import("./pipeline.ts");
      if (
        (await fingerprint()).digest !==
        (spec.runtimeFingerprint ?? spec.fingerprint)
      )
        throw new Error("worker_code_fingerprint_mismatch");
      if (group === "router" && !process.env.TYPESAFE_API_KEY?.trim())
        throw new Error("router_requires_typesafe_key");
      const groupDirectory = resolve(directory, "groups", group);
      mkdirSync(groupDirectory, { recursive: true });
      const lock = await acquireRunLock(groupDirectory);
      try {
        const registration = await rpc(path, {
          op: "register",
          phase: spec.id,
          group,
          pid: process.pid,
        });
        const epoch = Number(registration.epoch);
        const call = (request: RpcRequest, signal?: AbortSignal) =>
          rpc(path, { ...request, phase: spec.id, group, epoch }, signal);
        const runOne = async (job: JobRecord) => {
          const query = queries.get(job.caseId);
          if (!query) throw new Error("missing_query");
          const trialDir = resolve(groupDirectory, "trials", job.caseId);
          mkdirSync(trialDir, { recursive: true });
          const budget = new Budget(
            {
              ...PARALLEL_LIMITS,
              maxRequests: spec.maxRequests,
              maxTotalTokens: spec.maxTotalTokens,
            },
            true,
          );
          const checkpoint = new ParallelCheckpoint(
            resolve(trialDir, "checkpoint"),
            digest(`${spec.fingerprint}/${spec.id}/${job.key}`),
            job,
            call,
          );
          let row: Trial | undefined;
          active.add(checkpoint);
          try {
            await checkpoint.initialize();
            row = await runPiTrial({
              suite: "skillret",
              caseId: job.caseId,
              group,
              prompt: query.query,
              gold: query.skill_ids,
              catalog: loaded.catalog,
              ids,
              cwd: trialDir,
              agentDir: resolve(trialDir, "agent-state"),
              model: "gpt-6-luna",
              nativeOAuth: true,
              budget,
              transport: transport.fetch,
              checkpoint: resolve(trialDir, "partial.json"),
              durability: checkpoint,
              routerConfig: {
                ...PERSISTENT_ROUTER_CONFIG,
                routeTimeoutMs: 3600000,
                evaluationTimeoutMs: 3600000,
                batchTimeoutMs: 3600000,
              },
              routerDependencies: {
                onRouteStart: () => checkpoint.routing(true),
                onReport: (report) => {
                  checkpoint.routing(false);
                  if (report.status !== "selected")
                    checkpoint.pause(`route:${report.reason ?? report.status}`);
                },
              },
            });
            const paused = checkpoint.shouldPause();
            if (paused) {
              if (paused.startsWith("infrastructure:"))
                await call({ op: "infrastructure-failure" });
              if (paused === "service:pi" || paused === "service:jev")
                await call({
                  op: "pause",
                  provider: paused.endsWith("jev") ? "jev" : "pi",
                  reason: "worker_request_or_route_paused",
                });
              await call({ op: "job-paused", job: job.key, reason: paused });
              console.error(`PAUSED ${spec.id}/${job.key}: ${paused}`);
            } else {
              const result = await call({ op: "complete", job: job.key, row });
              if (result.paused) {
                await call({
                  op: "job-paused",
                  job: job.key,
                  reason: String(result.paused).startsWith("guard:")
                    ? String(result.paused)
                    : "service:pi",
                });
                console.error(`PAUSED ${spec.id}/${job.key}: ${result.paused}`);
              } else {
                atomicJson(resolve(trialDir, "partial.json"), row);
                console.log(
                  `${result.completedGroup}/${spec.queryIds.length} ${spec.id}/${job.key} completed; Pi ${row.requests.pi}, Jev ${row.requests.jev}`,
                );
              }
            }
          } catch {
            checkpoint.pause("infrastructure:worker_exception");
            try {
              await call({ op: "infrastructure-failure" });
              await call({
                op: "job-paused",
                job: job.key,
                reason: "infrastructure:worker_exception",
              });
            } catch {}
            console.error(
              `PAUSED ${spec.id}/${job.key}: checkpoint or coordinator error; inspect local state.`,
            );
          } finally {
            checkpoint.close();
            active.delete(checkpoint);
          }
        };
        await Promise.all(
          Array.from({ length: spec.concurrency }, async () => {
            for (;;) {
              if (stopRequested) return;
              let next: RpcReply;
              try {
                next = await call({ op: "next" });
              } catch {
                try {
                  const current = await rpc(path, { op: "phase" });
                  if (current.stopped || current.finished) {
                    stopRequested = true;
                    return;
                  }
                  if ((current.spec as PhaseSpec | undefined)?.id !== spec.id)
                    return;
                } catch {}
                await delay(1000);
                continue;
              }
              if (next.done) return;
              if (next.job) await runOne(next.job as JobRecord);
              else await delay(Number(next.waitMs) || 1000);
            }
          }),
        );
        lastPhase = spec.id;
        writeFileSync(
          resolve(groupDirectory, "worker-finished.json"),
          JSON.stringify({
            phase: spec.id,
            pid: process.pid,
            finishedAt: new Date().toISOString(),
          }),
        );
        console.log(
          `${spec.id}/${group}: all tasks finished; waiting for next stage.`,
        );
      } finally {
        await lock.close();
      }
    }
  } finally {
    clearInterval(watcher);
    globalThis.fetch = original;
    await transport.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const { values } = parseArgs({
    options: { pipeline: { type: "string" }, group: { type: "string" } },
    strict: true,
  });
  if (!values.pipeline || !["native", "router"].includes(values.group ?? ""))
    throw new Error("pipeline_and_group_required");
  worker(resolve(values.pipeline), values.group as Group).catch(() => {
    console.error(
      "Worker stopped; no provider requests will be made. Inspect coordinator state.",
    );
    process.exitCode = 1;
  });
}
