import { DEFAULT_CONFIG } from "../src/config.ts";

/** Explicit full-catalog profile. Interactive defaults remain 15s total. */
export const BENCHMARK_ROUTER_CONFIG = {
  ...DEFAULT_CONFIG,
  pinnedSkillPaths: [],
  evaluationTimeoutMs: 590000,
  routeTimeoutMs: 600000,
};
