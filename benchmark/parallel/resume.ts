import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicJson } from "../checkpoint.ts";
import { acquireRunLock } from "../recovery.ts";
import { PARALLEL_LIMITS, type PhaseSpec, POLICY } from "./protocol.ts";

interface Fingerprint {
  digest: string;
  files: Record<string, string>;
}
interface Manifest {
  version: number;
  fingerprint: Fingerprint;
  phases: PhaseSpec[];
  phaseIndex: number;
  status: string;
  policy: unknown;
  limits: unknown;
  codeCommit: string;
  coordinatorPid?: number;
  current?: { uncertainReservations: number };
  runtimeUpgrades?: unknown[];
  [key: string]: unknown;
}
// File-level gate for this reviewed guard/recovery repair. Plugin, data, SDK and
// transport files cannot change; reviewers must also preserve request semantics
// within the allowed harness files. Policies/limits are checked separately.
const compatibleFiles = new Set([
  "benchmark/pi.ts", // Only guard status preservation; reviewed with HTTP tests.
  "benchmark/types.ts",
  "benchmark/parallel/protocol.ts",
  "benchmark/parallel/ipc.ts",
  "benchmark/parallel/checkpoint.ts",
  "benchmark/parallel/coordinator.ts",
  "benchmark/parallel/worker.ts",
  "benchmark/parallel/pipeline.ts",
  "benchmark/parallel/resume.ts",
  "benchmark/parallel/reporting.ts",
]);
export function planRuntimeUpgrade(
  before: Manifest,
  code: Fingerprint,
  expectedFrom: string,
  commit: string,
) {
  const phase = before.phases[before.phaseIndex];
  if (
    before.version !== 3 ||
    before.fingerprint.digest !== expectedFrom ||
    !phase ||
    phase.kind !== "full" ||
    (!before.status.startsWith("paused") &&
      !before.status.startsWith("stopped:")) ||
    before.current?.uncertainReservations !== 0 ||
    JSON.stringify(before.policy) !== JSON.stringify(POLICY) ||
    JSON.stringify(before.limits) !== JSON.stringify(PARALLEL_LIMITS)
  )
    throw new Error("incompatible_runtime_upgrade");
  const changed = [
    ...new Set([
      ...Object.keys(before.fingerprint.files),
      ...Object.keys(code.files),
    ]),
  ].filter((path) => before.fingerprint.files[path] !== code.files[path]);
  if (!changed.length || changed.some((path) => !compatibleFiles.has(path)))
    throw new Error("runtime_upgrade_changes_experiment");
  const next = structuredClone(before);
  const record = {
    at: new Date().toISOString(),
    kind: "guard_and_resume_repair",
    from: before.fingerprint,
    to: code,
    fromCommit: before.codeCommit,
    toCommit: commit,
    changed,
    checkpointFingerprint: phase.fingerprint,
    completedResultsReused: true,
    requestIdentitiesUnchanged: true,
  };
  next.fingerprint = code;
  next.codeCommit = commit;
  // Keep the old fingerprint for checkpoint scopes and semantic request hashes.
  // Worker source validation uses the separately audited runtime fingerprint.
  next.phases[before.phaseIndex] = {
    ...phase,
    runtimeFingerprint: code.digest,
  };
  next.runtimeUpgrades = [...(before.runtimeUpgrades ?? []), record];
  next.status = "paused:runtime_upgrade";
  return { next, record };
}
function requireDead(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new Error("runtime_upgrade_owner_status_unknown");
  }
  throw new Error("stop_processes_before_runtime_upgrade");
}
export async function upgradePausedPipeline(
  root: string,
  code: Fingerprint,
  expectedFrom: string,
  commit: string,
) {
  const lock = await acquireRunLock(root);
  try {
    const before = JSON.parse(
      readFileSync(resolve(root, "pipeline.json"), "utf8"),
    ) as Manifest;
    requireDead(before.coordinatorPid);
    const phase = before.phases[before.phaseIndex];
    if (!phase) throw new Error("missing_upgrade_phase");
    const journal = resolve(
      root,
      `full-${phase.concurrency}`,
      "coordinator.jsonl",
    );
    const workers = new Map<string, number>();
    if (existsSync(journal)) {
      const raw = readFileSync(journal, "utf8");
      if (!raw.endsWith("\n")) throw new Error("repair_journal_before_upgrade");
      for (const line of raw.split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type === "worker") workers.set(event.group, event.worker.pid);
      }
    }
    for (const pid of workers.values()) requireDead(pid);
    const { next, record } = planRuntimeUpgrade(
      before,
      code,
      expectedFrom,
      commit,
    );
    const history = resolve(root, "runtime-upgrades");
    mkdirSync(history, { recursive: true });
    const backup = resolve(history, record.at.replace(/[^0-9]/g, ""));
    mkdirSync(backup);
    atomicJson(resolve(backup, "pipeline.before.json"), before);
    atomicJson(resolve(backup, "upgrade.json"), record);
    atomicJson(resolve(root, "pipeline.json"), next);
    return {
      upgraded: true,
      backup,
      checkpointFingerprint: record.checkpointFingerprint,
      changed: record.changed,
    };
  } finally {
    await lock.close();
  }
}
