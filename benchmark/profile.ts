import { DEFAULT_CONFIG } from "../src/config.ts";

/** Explicit full-catalog profile. Interactive defaults remain 15s total. */
export const BENCHMARK_ROUTER_CONFIG = {
  ...DEFAULT_CONFIG,
  // Frozen benchmark protocols own HTTP recovery and keep per-query batches serial.
  batchConcurrency: 1,
  batchMaxRetries: 0,
  pinnedSkillPaths: [],
  evaluationTimeoutMs: 590000,
  routeTimeoutMs: 600000,
};

/** Includes bounded HTTP recovery within one logical Jev batch. */
export const PERSISTENT_ROUTER_CONFIG = {
  ...BENCHMARK_ROUTER_CONFIG,
  batchTimeoutMs: 120000,
};
