import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Budget } from "./budget.ts";
import { contained, json, jsonl, loadSkillret, sha256 } from "./data.ts";
import { summarizeTrials } from "./metrics.ts";
import { mappingIds, runPiTrial } from "./pi.ts";
import { BENCHMARK_ROUTER_CONFIG } from "./profile.ts";
import { createBenchmarkTransport } from "./transport.ts";
import type { Group, Limits, Trial } from "./types.ts";

const project = resolve(import.meta.dirname, "..");
const data = resolve(project, "outputs/benchmark/data");
const python = resolve(
  project,
  "outputs/benchmark/.venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);

export function subprocess(
  command: string,
  args: string[],
  log?: (line: string) => void,
  environment?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: project,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...(environment ?? process.env), PYTHONUTF8: "1" },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      log?.(String(chunk));
    });
    child.once("error", () =>
      reject(new Error("benchmark_subprocess_unavailable")),
    );
    child.once("exit", (code) =>
      code === 0
        ? done(stdout)
        : reject(new Error(`benchmark_subprocess_failed_${code}`)),
    );
  });
}

async function frozenFingerprint() {
  const files = [
    "package-lock.json",
    "benchmark/sources.json",
    "benchmark/blocked-inputs.json",
    "benchmark/requirements.txt",
  ];
  for (const directory of ["src", "benchmark"]) {
    for (const file of (await readdir(resolve(project, directory)))
      .filter((f) => /\.(ts|py)$/.test(f))
      .sort())
      files.push(`${directory}/${file}`);
  }
  const hashes: Record<string, string> = {};
  for (const file of files)
    hashes[file] = sha256(await readFile(resolve(project, file)));
  return { digest: sha256(JSON.stringify(hashes)), files: hashes };
}

export function readLimits(values: Record<string, unknown>): Limits {
  const read = (name: string) => {
    const input = values[name];
    if (
      typeof input !== "string" ||
      !/^[1-9]\d*$/.test(input) ||
      !Number.isSafeInteger(Number(input))
    )
      throw new Error(
        `Explicit positive --${name} is required for live execution`,
      );
    return Number(input);
  };
  return {
    maxRequests: read("max-requests"),
    maxTotalTokens: read("max-total-tokens"),
    maxTurns: read("max-turns"),
    maxOutputTokens: read("max-output-tokens"),
    taskTimeoutMs: read("task-timeout-ms"),
  };
}

export async function writeReport(
  output: string,
  rows: Trial[],
  expected: Record<string, number>,
  live: boolean,
) {
  const groups = summarizeTrials(rows, expected);
  if (
    rows.some((r) => r.evidence === "mock") &&
    rows.some((r) => r.evidence === "live")
  )
    throw new Error("Cannot mix mock and live results");
  const summary = {
    schemaVersion: 1,
    evidence: rows.some((r) => r.evidence === "mock")
      ? "mock"
      : live
        ? "live"
        : "no-live-results",
    expectedPerGroup: expected,
    groups,
    notes: [
      "SkillRet metadata adaptation; not official full-text leaderboard scores",
      "SkillsBench curated associations are not exhaustive relevance labels",
      "Total tokens include cache tokens once; reasoning is an output subset",
      "Token stop occurs after responses; an in-flight response can exceed the remaining token budget",
      "No billed USD cost is inferred from a proxy alias",
      "fix-druid-loophole-cve is blocked by host security software; the original 87-task denominator is retained",
    ],
  };
  await writeFile(
    resolve(output, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  const columns = [
    "suite",
    "caseId",
    "group",
    "status",
    "taskSuccess",
    "piTokens",
    "jevTokens",
    "usageComplete",
    "elapsedMs",
  ];
  const csv = [
    columns.join(","),
    ...rows.map((r) =>
      [
        r.suite,
        r.caseId,
        r.group,
        r.status,
        r.taskSuccess ?? "",
        r.pi.total,
        r.jev.total,
        r.pi.complete && r.jev.complete,
        r.elapsedMs,
      ].join(","),
    ),
  ].join("\n");
  await writeFile(resolve(output, "results.csv"), `${csv}\n`);
  return summary;
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      preflight: { type: "boolean" },
      report: { type: "boolean" },
      resume: { type: "boolean" },
      suite: { type: "string", default: "all" },
      output: { type: "string" },
      "max-requests": { type: "string" },
      "max-total-tokens": { type: "string" },
      "max-turns": { type: "string" },
      "max-output-tokens": { type: "string" },
      "task-timeout-ms": { type: "string" },
    },
    strict: true,
  });
  if (!["all", "skillret", "skillsbench"].includes(values.suite))
    throw new Error("Unknown suite");
  if (values.report) {
    if (!values.output)
      throw new Error("--report requires --output <existing run directory>");
    const output = contained(
      resolve(project, "outputs/benchmark"),
      values.output,
    );
    const meta = await json<{ expectedPerGroup: Record<string, number> }>(
      resolve(output, "run.json"),
    );
    const rows = await jsonl<Trial>(resolve(output, "results.jsonl"));
    await writeReport(
      output,
      rows,
      meta.expectedPerGroup,
      rows.some((r) => r.evidence === "live"),
    );
    await subprocess(python, ["benchmark/report.py", output]);
    console.log(`Report: ${output}`);
    return;
  }
  const sourceLock = await json<{
    executionModel: string;
    executionAuth?: string;
    executionProvider?: string;
    executionThinking?: string;
    skillret: { skills: number; queries: number };
    skillsbench: { tasks: number };
  }>(resolve(project, "benchmark/sources.json"));
  const expected = {
    skillret: values.suite === "skillsbench" ? 0 : sourceLock.skillret.queries,
    skillsbench: values.suite === "skillret" ? 0 : sourceLock.skillsbench.tasks,
  };
  const root = resolve(project, "outputs/benchmark");
  const output = values.output
    ? contained(root, values.output)
    : resolve(
        root,
        values.live
          ? `runs/${new Date().toISOString().replaceAll(/[:.]/g, "-")}`
          : "preview",
      );
  await mkdir(output, { recursive: true });
  const fingerprint = await frozenFingerprint();
  const baseMeta = {
    schemaVersion: 1,
    sourceLock,
    fingerprint,
    expectedPerGroup: expected,
    repetitions: 1,
    blockedInputs: await json(
      resolve(project, "benchmark/blocked-inputs.json"),
    ),
    model: sourceLock.executionModel,
    authentication: sourceLock.executionAuth ?? "api-key",
    provider: sourceLock.executionProvider ?? "benchmark-openai",
    api:
      sourceLock.executionAuth === "pi-oauth"
        ? "native-provider"
        : "openai-completions",
    reasoningEffort: sourceLock.executionThinking ?? "none",
    routerConfig: BENCHMARK_ROUTER_CONFIG,
    isolation: {
      autoDiscovery: false,
      otherExtensions: false,
      contextFiles: false,
      sessions: "fresh-in-memory",
      pi: "1.3.0",
    },
    budgetPolicy:
      "Actual HTTP request cap; observed token stop after each response, unknown usage stops further requests; no retries",
    status: "prepared",
  };
  if (!values.live) {
    await writeFile(
      resolve(output, "run.json"),
      JSON.stringify(baseMeta, null, 2),
    );
    await writeFile(resolve(output, "results.jsonl"), "");
    if (values.preflight) {
      const loaded = await loadSkillret(data);
      const tasks = JSON.parse(
        await subprocess(python, ["benchmark/preflight.py", data]),
      );
      await writeFile(
        resolve(output, "preflight.json"),
        JSON.stringify(
          {
            skills: loaded.catalog.length,
            queries: loaded.queries.length,
            nativeWarnings: loaded.diagnostics,
            skillsbench: tasks,
          },
          null,
          2,
        ),
      );
      console.log(
        `Input audit: ${loaded.catalog.length} skills, ${loaded.queries.length} queries, ${tasks.count}/${tasks.expected} task digests; blocked=${tasks.blockedTasks.length}`,
      );
      if (!tasks.ready) {
        process.exitCode = 2;
        await writeFile(
          resolve(output, "run.json"),
          JSON.stringify(
            { ...baseMeta, status: "prepared_with_blocked_inputs" },
            null,
            2,
          ),
        );
      }
    }
    await writeReport(output, [], expected, false);
    await subprocess(python, ["benchmark/report.py", output]);
    console.log(`No model requests. Plan/report: ${output}`);
    return;
  }
  const limits = readLimits(values);
  const nativeOAuth = sourceLock.executionAuth === "pi-oauth";
  if (
    (!nativeOAuth &&
      (!process.env.LLM_API_KEY?.trim() ||
        !process.env.LLM_BASE_URL?.trim())) ||
    !process.env.TYPESAFE_API_KEY?.trim()
  )
    throw new Error(
      nativeOAuth
        ? "TYPESAFE_API_KEY and an existing Pi OpenAI OAuth account are required"
        : "LLM_API_KEY, LLM_BASE_URL and TYPESAFE_API_KEY are required; no credential-file fallback",
    );
  const apiRoot = new URL(
    nativeOAuth
      ? "https://api.openai.com/v1"
      : (process.env.LLM_BASE_URL ?? ""),
  );
  if (
    !["http:", "https:"].includes(apiRoot.protocol) ||
    apiRoot.username ||
    apiRoot.password ||
    apiRoot.search ||
    apiRoot.hash
  )
    throw new Error("Invalid LLM_BASE_URL");
  const previous: Trial[] = values.resume
    ? await jsonl<Trial>(resolve(output, "results.jsonl"))
    : [];
  if (values.resume) {
    const old = await json<{
      fingerprint: { digest: string };
      model: string;
      expectedPerGroup: Record<string, number>;
    }>(resolve(output, "run.json"));
    if (
      old.fingerprint.digest !== fingerprint.digest ||
      old.model !== sourceLock.executionModel ||
      JSON.stringify(old.expectedPerGroup) !== JSON.stringify(expected)
    )
      throw new Error("Resume requires identical source, model and suite");
    if (previous.some((r) => !r.pi.complete || !r.jev.complete))
      throw new Error("Unknown usage prevents automatic budget-safe resume");
  } else {
    await writeFile(resolve(output, "results.jsonl"), "", { flag: "wx" });
  }
  // Exclusive run lock: an interrupted run must be inspected before its lock is removed.
  const lock = await import("node:fs/promises").then((fs) =>
    fs.open(resolve(output, "running.lock"), "wx"),
  );
  const budget = new Budget(limits);
  const transport = createBenchmarkTransport();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = transport.fetch; // Also lets native OAuth refresh use the same process-local proxy.
  for (const row of previous) {
    budget.requests += row.requests.pi + row.requests.jev;
    budget.tokens += row.pi.total + row.jev.total;
  }
  const rows = [...previous];
  const completed = new Set(
    rows.map((r) => `${r.suite}/${r.caseId}/${r.group}`),
  );
  let status = "running";
  await writeFile(
    resolve(output, "run.json"),
    JSON.stringify(
      { ...baseMeta, limits, status, transport: transport.mode },
      null,
      2,
    ),
  );
  try {
    // Preflight both locked datasets before any paid traffic.
    const loaded = await loadSkillret(data);
    const taskAudit = JSON.parse(
      await subprocess(python, ["benchmark/preflight.py", data]),
    ) as { tasks: { name: string }[]; ready: boolean; blockedTasks: unknown[] };
    await writeFile(
      resolve(output, "preflight.json"),
      JSON.stringify(taskAudit, null, 2),
    );
    if (expected.skillsbench && !taskAudit.ready) {
      budget.stopped = "blocked_inputs";
      throw new Error("SkillsBench inputs blocked; no model requests sent");
    }
    const jobs: Array<{ suite: "skillret" | "skillsbench"; id: string }> = [
      ...(expected.skillret
        ? loaded.queries.map((q) => ({ suite: "skillret" as const, id: q.id }))
        : []),
      ...(expected.skillsbench
        ? taskAudit.tasks.map((t) => ({
            suite: "skillsbench" as const,
            id: t.name,
          }))
        : []),
    ];
    for (const [index, job] of jobs.entries()) {
      // Alternate pair order to reduce systematic warm-cache/order effects; no shared sessions.
      for (const group of (index % 2
        ? ["router", "native"]
        : ["native", "router"]) as Group[]) {
        if (completed.has(`${job.suite}/${job.id}/${group}`)) continue;
        budget.check();
        const trialDir = contained(
          output,
          `trials/${job.suite}/${job.id}/${group}`,
        );
        await mkdir(trialDir, { recursive: true });
        let row: Trial;
        if (job.suite === "skillret") {
          const query = loaded.queries.find((q) => q.id === job.id);
          if (!query) throw new Error("Missing query");
          row = await runPiTrial({
            suite: job.suite,
            caseId: query.id,
            group,
            prompt: query.query,
            gold: query.skill_ids,
            catalog: loaded.catalog,
            ids: mappingIds(loaded.catalog, loaded.byFile),
            cwd: trialDir,
            agentDir: resolve(trialDir, "agent-state"),
            model: sourceLock.executionModel,
            nativeOAuth,
            transport: transport.fetch,
            ...(!nativeOAuth
              ? {
                  baseUrl: process.env.LLM_BASE_URL ?? "",
                  apiKey: process.env.LLM_API_KEY ?? "",
                }
              : {}),
            budget,
            checkpoint: resolve(trialDir, "partial.json"),
          });
        } else {
          const config = {
            task: resolve(data, "skillsbench/tasks", job.id),
            output: trialDir,
            group,
            project,
            node: process.execPath,
            model: sourceLock.executionModel,
            nativeOAuth,
            limits: {
              ...limits,
              maxRequests: limits.maxRequests - budget.requests,
              maxTotalTokens: limits.maxTotalTokens - budget.tokens,
            },
          };
          const configFile = resolve(trialDir, "bridge-config.json");
          await writeFile(configFile, JSON.stringify(config, null, 2));
          const result = JSON.parse(
            await subprocess(
              python,
              ["benchmark/skillsbench.py", configFile],
              (line) => {
                process.stderr.write(line);
              },
            ),
          ) as { row: Trial; stopped: string | null };
          if (!result.row)
            throw new Error("SkillsBench bridge returned no evidence");
          row = result.row;
          budget.requests += row.requests.pi + row.requests.jev;
          budget.account(
            row.pi.complete && row.jev.complete
              ? row.pi.total + row.jev.total
              : null,
          );
          if (result.stopped) budget.stopped = result.stopped;
        }
        rows.push(row);
        await appendFile(
          resolve(output, "results.jsonl"),
          `${JSON.stringify(row)}\n`,
        );
        await writeReport(output, rows, expected, true);
        console.log(
          `${rows.length}: ${job.suite}/${job.id}/${group} ${row.status}`,
        );
      }
    }
    status = "complete";
  } catch {
    status = budget.stopped ? `stopped:${budget.stopped}` : "harness_error";
    process.exitCode = 1;
  } finally {
    await writeFile(
      resolve(output, "run.json"),
      JSON.stringify(
        {
          ...baseMeta,
          limits,
          status,
          requests: budget.requests,
          knownTokens: budget.tokens,
          transport: transport.mode,
        },
        null,
        2,
      ),
    );
    try {
      await writeReport(output, rows, expected, true);
      await subprocess(python, ["benchmark/report.py", output]);
    } finally {
      globalThis.fetch = originalFetch;
      await transport.close();
      await lock.close();
      await import("node:fs/promises").then((fs) =>
        fs.unlink(resolve(output, "running.lock")),
      );
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  main().catch((error: unknown) => {
    // Never emit transport/provider exception bodies, endpoints or credentials.
    const message =
      error instanceof Error &&
      /^(Explicit positive|LLM_API_KEY|Unknown suite|--report|Resume requires|Unknown usage|Invalid LLM_BASE_URL|Run benchmark:prepare)/.test(
        error.message,
      )
        ? error.message
        : "Benchmark preparation/run failed; inspect local preflight evidence and setup instructions.";
    console.error(message);
    process.exitCode = 1;
  });
}
