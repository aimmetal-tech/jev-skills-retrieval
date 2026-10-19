import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { atomicJson } from "../checkpoint.ts";
import { contained, loadSkillret } from "../data.ts";
import { acquireRunLock } from "../recovery.ts";
import { subprocess } from "../run.ts";
import { Coordinator } from "./coordinator.ts";
import { rpc, serve, socketPath } from "./ipc.ts";
import {
  digest,
  PARALLEL_LIMITS,
  type PhaseSpec,
  POLICY,
  type Provider,
  type RpcRequest,
  selectQueries,
} from "./protocol.ts";
import {
  executionStatus,
  phaseReport,
  qualification,
  selectConcurrency,
} from "./reporting.ts";
import { upgradePausedPipeline } from "./resume.ts";

const project = resolve(import.meta.dirname, "../..");
const outputRoot = resolve(project, "outputs/benchmark");
const python = resolve(
  outputRoot,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
export async function fingerprint() {
  const paths = [
    "package.json",
    "package-lock.json",
    "benchmark/sources.json",
    "benchmark/requirements.txt",
    "benchmark/blocked-inputs.json",
  ];
  async function visit(dir: string) {
    for (const f of (
      await readdir(resolve(project, dir), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (f.isDirectory()) await visit(`${dir}/${f.name}`);
      else if (/\.(ts|py|ps1)$/.test(f.name)) paths.push(`${dir}/${f.name}`);
    }
  }
  await visit("src");
  await visit("benchmark");
  const files: Record<string, string> = {};
  for (const path of paths)
    files[path] = digest(await readFile(resolve(project, path)));
  return { digest: digest(JSON.stringify(files)), files };
}
interface PipelineManifest {
  version: 3;
  id: string;
  fingerprint: Awaited<ReturnType<typeof fingerprint>>;
  codeCommit: string;
  startedAt: string;
  calibrationIds: string[];
  allQueryIds: string[];
  sourceLock: unknown;
  phaseIndex: number;
  phases: PhaseSpec[];
  status: string;
  selectedConcurrency?: 3 | 5;
  phaseStartedAt: string;
  results: Record<string, ReturnType<typeof qualification>>;
  oldResultsImported: false;
  automaticFull: boolean;
}
function launchSessions(root: string, namespace: string) {
  for (const group of ["native", "router"]) {
    const result = spawnSync(
      "psmux",
      [
        "-L",
        namespace,
        "new-session",
        "-d",
        "-s",
        group,
        "-c",
        project,
        "--",
        "pwsh",
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
        "-File",
        resolve(project, "benchmark/parallel/session.ps1"),
        "-Pipeline",
        root,
        "-Group",
        group,
      ],
      { windowsHide: true, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error("parallel_psmux_launch_failed");
  }
  atomicJson(resolve(root, "psmux.json"), {
    namespace,
    sessions: ["native", "router"],
    startedAt: new Date().toISOString(),
    resume: false,
    oldResultsImported: false,
  });
}
export async function pipeline(
  root: string,
  resume = false,
  automaticFull = true,
) {
  if (!resume && existsSync(root))
    throw new Error("fresh_pipeline_directory_required");
  mkdirSync(root, { recursive: true });
  const lock = await acquireRunLock(root);
  let manifest: PipelineManifest;
  try {
    const code = await fingerprint();
    if (resume) {
      manifest = JSON.parse(
        readFileSync(resolve(root, "pipeline.json"), "utf8"),
      );
      if (manifest.version !== 3 || manifest.fingerprint.digest !== code.digest)
        throw new Error("pipeline_resume_fingerprint_mismatch");
    } else {
      if (!process.env.TYPESAFE_API_KEY?.trim())
        throw new Error("pipeline_requires_typesafe_key");
      const runtime = await ModelRuntime.create({
        authPath: resolve(homedir(), ".pi/agent/auth.json"),
        modelsPath: resolve(homedir(), ".pi/agent/models.json"),
        allowModelNetwork: false,
      });
      if (
        !runtime.isUsingOAuth("openai") ||
        !runtime.getModel("openai", "gpt-6-luna")
      )
        throw new Error("pipeline_requires_native_openai_oauth_model");
      const loaded = await loadSkillret(resolve(outputRoot, "data"));
      const taskAudit = JSON.parse(
        await subprocess(python, [
          "benchmark/preflight.py",
          resolve(outputRoot, "data"),
        ]),
      );
      atomicJson(resolve(root, "preflight.json"), {
        skillret: {
          skills: loaded.catalog.length,
          queries: loaded.queries.length,
        },
        skillsbench: taskAudit,
        skillsbenchLive: false,
      });
      const sourceLock = JSON.parse(
        readFileSync(resolve(project, "benchmark/sources.json"), "utf8"),
      );
      if (
        sourceLock.executionModel !== "gpt-6-luna" ||
        sourceLock.executionProvider !== "openai" ||
        sourceLock.executionThinking !== "medium" ||
        sourceLock.executionAuth !== "pi-oauth"
      )
        throw new Error("pipeline_source_protocol_mismatch");
      const id = root.split(/[\\/]/).at(-1) as string;
      const calibrationIds = selectQueries(loaded.queries).map((q) => q.id);
      const phase = (concurrency: 3 | 5): PhaseSpec => ({
        version: 3,
        id: `${id}-calibration-${concurrency}`,
        fingerprint: code.digest,
        concurrency,
        queryIds: calibrationIds,
        kind: "calibration",
        maxRequests: 40000,
        maxTotalTokens: PARALLEL_LIMITS.maxTotalTokens,
        evidence: "live",
      });
      const git = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: project,
        windowsHide: true,
        encoding: "utf8",
      });
      manifest = {
        version: 3,
        id,
        fingerprint: code,
        codeCommit: git.status === 0 ? git.stdout.trim() : "unknown",
        startedAt: new Date().toISOString(),
        calibrationIds,
        allQueryIds: loaded.queries.map((q) => q.id),
        sourceLock,
        phaseIndex: 0,
        phases: [phase(3), phase(5)],
        status: "running",
        phaseStartedAt: new Date().toISOString(),
        results: {},
        oldResultsImported: false,
        automaticFull,
      };
      atomicJson(resolve(root, "calibration-selection.json"), {
        seed: 20261019,
        method: "20 equal query-length strata; SHA256 seeded choice, no qrels",
        queryIds: calibrationIds,
        plannedTrials: 80,
        candidateCount: loaded.catalog.length,
      });
    }
    atomicJson(resolve(root, "pipeline.json"), {
      ...manifest,
      policy: POLICY,
      limits: PARALLEL_LIMITS,
    });
  } catch (e) {
    await lock.close();
    throw e;
  }
  const phaseDirectory = (s: PhaseSpec) =>
    resolve(
      root,
      s.kind === "calibration"
        ? `calibration-${s.concurrency}`
        : `full-${s.concurrency}`,
    );
  let spec = manifest.phases[manifest.phaseIndex] as PhaseSpec;
  let coordinator = new Coordinator(phaseDirectory(spec), spec);
  let stopping = false,
    blocked = "",
    reporting = false,
    lastRender = 0,
    lastReport = 0,
    lastCount = -1;
  const save = () =>
    atomicJson(resolve(root, "pipeline.json"), {
      ...manifest,
      policy: POLICY,
      limits: PARALLEL_LIMITS,
      coordinatorPid: process.pid,
      updatedAt: new Date().toISOString(),
      current: coordinator.summary(),
    });
  const server = await serve(socketPath(root), async (r: RpcRequest) => {
    if (r.op === "phase")
      return {
        ok: true,
        spec,
        directory: coordinator.directory,
        blocked: !!blocked,
        finished: manifest.status === "complete",
        stopped: stopping,
      };
    if (r.op === "status")
      return { ok: true, pipeline: manifest, status: coordinator.summary() };
    if (r.op === "operator-stop") {
      coordinator.pause("pi", "user_stop");
      coordinator.pause("jev", "user_stop");
      manifest.status = "stopped:user";
      stopping = true;
      save();
      return { ok: true };
    }
    if (r.op === "operator-resume") {
      const provider = r.provider as Provider;
      if (!["pi", "jev"].includes(provider))
        throw new Error("invalid_provider");
      coordinator.resume(provider, r.newCycle === true);
      save();
      return { ok: true };
    }
    if (r.op === "operator-extend") {
      coordinator.extend(
        String(r.job),
        Number(r.workMs ?? 0),
        Number(r.routeMs ?? 0),
        Number(r.onlineMs ?? 0),
      );
      save();
      return { ok: true };
    }
    if (r.op === "operator-recover-infrastructure") {
      coordinator.recoverInfrastructure();
      save();
      return { ok: true };
    }
    return coordinator.handle(r);
  });
  try {
    if (!resume) {
      const namespace = `jev-parallel-${manifest.id.replace(/[^a-zA-Z0-9-]/g, "-")}`;
      launchSessions(root, namespace);
    } else
      console.log(
        "Resumed coordinator is fail-closed; stop old workers and explicitly recover infrastructure before restarting workers.",
      );
    console.log(`Independent pipeline: ${root}`);
    for (;;) {
      coordinator.checkOwners();
      coordinator.saveStatus();
      const sum = coordinator.summary();
      if (!stopping)
        manifest.status = blocked
          ? `paused:${blocked}`
          : executionStatus(coordinator);
      if (
        Date.now() - Date.parse(manifest.phaseStartedAt) > 120000 &&
        coordinator.workers.size < 2
      ) {
        blocked = "worker_startup_failed";
        coordinator.pause("pi", blocked);
        coordinator.pause("jev", blocked);
      }
      save();
      const render =
        Date.now() - lastRender >= 60000 ||
        stopping ||
        sum.completed === sum.expected;
      if (
        !reporting &&
        (Date.now() - lastReport >= 5000 ||
          sum.completed !== lastCount ||
          render)
      ) {
        reporting = true;
        try {
          await phaseReport(coordinator);
          lastCount = sum.completed;
          lastReport = Date.now();
          // A compact authoritative completed journal is generated by one writer only.
          writeFileSync(
            resolve(coordinator.directory, "results.jsonl"),
            coordinator
              .rows()
              .map((r) => JSON.stringify(r))
              .join("\n") + (coordinator.rows().length ? "\n" : ""),
          );
          if (render) {
            await subprocess(python, [
              "benchmark/report.py",
              coordinator.directory,
            ]);
            lastRender = Date.now();
          }
        } finally {
          reporting = false;
        }
      }
      if (stopping && sum.uncertainReservations === 0) {
        await delay(2000);
        break;
      }
      if (!blocked && sum.completed === sum.expected) {
        const elapsedMs = Date.now() - Date.parse(manifest.phaseStartedAt);
        if (spec.kind === "calibration") {
          const result = qualification(coordinator, elapsedMs);
          manifest.results[String(spec.concurrency)] = result;
          if (spec.concurrency === 3 && !result.eligible) {
            blocked = "calibration_3_failed";
            save();
            continue;
          }
          if (spec.concurrency === 5) {
            const three = manifest.results["3"];
            if (!three) throw new Error("missing_calibration_three");
            const choice = selectConcurrency(three, result);
            if (!choice) {
              blocked = "calibration_selection_failed";
              save();
              continue;
            }
            manifest.selectedConcurrency = choice;
            atomicJson(resolve(root, "selection.json"), {
              three,
              five: result,
              selectedConcurrency: choice,
              rule: "eligible; 5 requires at least 20% higher throughput; otherwise 3",
              oldResultsImported: false,
            });
            if (!manifest.automaticFull) {
              blocked = "awaiting_full_start";
              save();
              continue;
            }
            manifest.phases.push({
              version: 3,
              id: `${manifest.id}-full-${choice}`,
              fingerprint: manifest.fingerprint.digest,
              concurrency: choice,
              queryIds: manifest.allQueryIds,
              kind: "full",
              maxRequests: PARALLEL_LIMITS.maxRequests,
              maxTotalTokens: PARALLEL_LIMITS.maxTotalTokens,
              evidence: "live",
            });
          }
          if (spec.concurrency === 3) {
            const next = manifest.phases[1];
            if (!next) throw new Error("missing_next_phase");
            next.maxRequests = 40000 - coordinator.attempts.size;
            next.maxTotalTokens =
              PARALLEL_LIMITS.maxTotalTokens - coordinator.knownTokens;
          }
          coordinator.close();
          manifest.phaseIndex++;
          spec = manifest.phases[manifest.phaseIndex] as PhaseSpec;
          manifest.phaseStartedAt = new Date().toISOString();
          coordinator = new Coordinator(phaseDirectory(spec), spec);
          lastCount = -1;
          lastRender = 0;
          save();
          console.log(
            `Next independent stage: ${spec.id}; per-group tasks ${spec.concurrency}.`,
          );
        } else {
          manifest.status = "complete";
          save();
          console.log("Full SkillRet two-group pipeline completed.");
          await delay(2000);
          break;
        }
      }
      await delay(1000);
    }
  } catch {
    manifest.status = "paused:orchestrator_failure";
    stopping = true;
    coordinator.pause("pi", "orchestrator_failure");
    coordinator.pause("jev", "orchestrator_failure");
    save();
    await delay(2000);
  } finally {
    await phaseReport(coordinator);
    await subprocess(python, ["benchmark/report.py", coordinator.directory]);
    save();
    await new Promise<void>((done) => server.close(() => done()));
    coordinator.close();
    await lock.close();
  }
}
export async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      live: { type: "boolean" },
      resume: { type: "boolean" },
      status: { type: "boolean" },
      stop: { type: "boolean" },
      "resume-provider": { type: "string" },
      "new-cycle": { type: "boolean" },
      "recover-infrastructure": { type: "boolean" },
      "extend-job": { type: "string" },
      "work-minutes": { type: "string" },
      "route-minutes": { type: "string" },
      "online-minutes": { type: "string" },
      "calibration-only": { type: "boolean" },
      "upgrade-runtime-from": { type: "string" },
    },
    strict: true,
  });
  if (!values.output) throw new Error("output_required");
  const root = contained(outputRoot, values.output);
  if (root === outputRoot)
    throw new Error("specific_pipeline_directory_required");
  if (values["upgrade-runtime-from"]) {
    const git = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: project,
      windowsHide: true,
      encoding: "utf8",
    });
    if (git.status !== 0) throw new Error("upgrade_commit_required");
    console.log(
      JSON.stringify(
        await upgradePausedPipeline(
          root,
          await fingerprint(),
          values["upgrade-runtime-from"],
          git.stdout.trim(),
        ),
        null,
        2,
      ),
    );
    return;
  }
  let request: RpcRequest | undefined;
  if (values.status) request = { op: "status" };
  if (values.stop) request = { op: "operator-stop" };
  if (values["resume-provider"])
    request = {
      op: "operator-resume",
      provider: values["resume-provider"],
      newCycle: !!values["new-cycle"],
    };
  if (values["recover-infrastructure"])
    request = { op: "operator-recover-infrastructure" };
  if (values["extend-job"])
    request = {
      op: "operator-extend",
      job: values["extend-job"],
      workMs: Number(values["work-minutes"] ?? 0) * 60000,
      routeMs: Number(values["route-minutes"] ?? 0) * 60000,
      onlineMs: Number(values["online-minutes"] ?? 0) * 60000,
    };
  if (request) {
    const reply = await rpc(socketPath(root), request);
    console.log(JSON.stringify(reply, null, 2));
    return;
  }
  if (!values.live) throw new Error("explicit_live_required");
  await pipeline(root, !!values.resume, !values["calibration-only"]);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
)
  main().catch((error: unknown) => {
    if (error instanceof Error && /^[a-z0-9_]+$/.test(error.message))
      console.error(error.message);
    console.error(
      "Parallel pipeline stopped; inspect local protocol, preflight and coordinator evidence. No provider error body is logged.",
    );
    process.exit(1);
  });
