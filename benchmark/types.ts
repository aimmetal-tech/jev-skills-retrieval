import type { BatchAttempt } from "../src/batching.ts";
import type { RouteReport } from "../src/router.ts";

export type Group = "native" | "router";
export type Suite = "skillret" | "skillsbench";
export interface SkillMapping {
  id: string;
  name: string;
  originalName: string;
  path: string;
  sha256: string;
}
export interface Query {
  id: string;
  query: string;
  skill_ids: string[];
}
export interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
  total: number;
  complete: boolean;
}
export interface ReadEvidence {
  id: string;
  offset: number;
  limit: number | null;
  truncated: boolean;
}
export interface Trial {
  schemaVersion: 1;
  suite: Suite;
  caseId: string;
  group: Group;
  evidence: "live" | "mock";
  model: string;
  execution?: {
    provider: string;
    authentication: string;
    api: string;
    thinking: string;
    contextWindow: number;
  };
  responseModels: string[];
  status:
    | "completed"
    | "provider_error"
    | "timeout"
    | "budget"
    | "harness_error";
  httpStatus: number | null;
  failure?: "context_limit" | "provider_error";
  providerPayloadBytes?: number;
  elapsedMs: number;
  catalogCount: number;
  selectedIds: string[];
  reads: ReadEvidence[];
  relevantIds: string[];
  routeReports: RouteReport[];
  jevAttempts?: BatchAttempt[];
  recovery?: {
    schemaVersion: 2;
    resumes: number;
    replayed: { pi: number; jev: number };
    unknownRequests: number;
  };
  pi: Counts;
  jev: Counts;
  requests: { pi: number; jev: number };
  taskSuccess: boolean | null;
  verifierStatus: "not_applicable" | "pending" | "passed" | "failed" | "error";
}
export const emptyCounts = (): Counts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: null,
  total: 0,
  complete: true,
});

export interface Limits {
  maxRequests: number;
  maxTotalTokens: number;
  maxTurns: number;
  maxOutputTokens: number;
  taskTimeoutMs: number;
}
