import { createHash } from "node:crypto";
import type { Counts, Group, Trial } from "../types.ts";

export const PARALLEL_VERSION = 3;
export type Provider = "pi" | "jev";
export const PARALLEL_LIMITS = {
  maxRequests: 700000,
  maxTotalTokens: 100000000000,
  maxTurns: 12,
  maxOutputTokens: 4096,
  taskTimeoutMs: 1200000,
};
export const POLICY = {
  maxRetries: 5,
  backoffMs: [5000, 10000, 20000, 40000, 80000],
  jitter: 0.2,
  jevTimeoutMs: 10000,
  piTimeoutMs: 120000,
  routeWorkMs: 600000,
  taskWorkMs: 1200000,
  onlineMs: 3600000,
  batchIntervalMs: 1000,
};
export const retryable = (status: number | null) =>
  status === null || [408, 429, 500, 502, 503, 504, 529].includes(status);
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export interface PhaseSpec {
  version: 3;
  id: string;
  fingerprint: string;
  concurrency: 3 | 5;
  queryIds: string[];
  kind: "calibration" | "full";
  maxRequests: number;
  maxTotalTokens: number;
  evidence: "live" | "mock";
}
export interface AttemptRecord {
  id: string;
  requestKey: string;
  job: string;
  group: Group;
  provider: Provider;
  epoch: number;
  cycle: number;
  startedAt: number;
  status: number | null;
  state: "pending" | "settled";
  usage: Counts;
  reason?: string;
}
export interface JobRecord {
  key: string;
  caseId: string;
  group: Group;
  state: "queued" | "running" | "paused" | "completed";
  owner?: number;
  reason?: string;
  extraWorkMs: number;
  extraRouteMs: number;
  extraOnlineMs: number;
  row?: Trial;
}
export interface WorkerRecord {
  pid: number;
  epoch: number;
}
export interface Pause {
  reason: string;
  requestKey?: string;
}
export type Event =
  | { type: "worker"; group: Group; worker: WorkerRecord }
  | { type: "worker-exited"; group: Group }
  | { type: "job"; job: JobRecord }
  | { type: "begin"; attempt: AttemptRecord }
  | {
      type: "end";
      id: string;
      status: number | null;
      usage: Counts;
      reason?: string;
    }
  | { type: "reconcile"; id: string; status: number | null; usage: Counts }
  | { type: "cooldown"; provider: Provider; until: number }
  | { type: "pause"; provider: Provider; pause: Pause }
  | { type: "resume"; provider: Provider; newCycles: Record<string, number> }
  | { type: "fatal"; reason: string };
export interface RpcRequest {
  op: string;
  phase?: string;
  group?: Group;
  epoch?: number;
  [key: string]: unknown;
}
export interface RpcReply {
  ok: boolean;
  [key: string]: unknown;
}
export interface TimingState {
  workMs: number;
  queueMs: number;
  backoffMs: number;
  cooldownMs: number;
  onlineMs: number;
  routeWorkMs: number;
  naturalStartedAt: string;
  savedAt: string;
  resumes: number;
}

export function selectQueries<T extends { id: string; query: string }>(
  queries: T[],
  count = 20,
) {
  if (queries.length < count)
    throw new Error("insufficient_calibration_queries");
  // Equal length strata; seed hashes choose one item per stratum without qrels.
  const ordered = [...queries].sort(
    (a, b) => a.query.length - b.query.length || a.id.localeCompare(b.id),
  );
  return Array.from({ length: count }, (_, i) => {
    const bucket = ordered.slice(
      Math.floor((i * ordered.length) / count),
      Math.floor(((i + 1) * ordered.length) / count),
    );
    bucket.sort((a, b) =>
      digest(`20261019/${a.id}`).localeCompare(digest(`20261019/${b.id}`)),
    );
    return bucket[0] as T;
  });
}
