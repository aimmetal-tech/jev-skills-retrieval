import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildRoutingState } from "../src/context.ts";
import { createJevEvaluator } from "../src/jev-client.ts";
import { route } from "../src/router.ts";
import { cases, catalog } from "./dataset.ts";
import { type EvaluationRow, summarize } from "./metrics.ts";

const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    output: { type: "string", default: "outputs/evaluation.json" },
    repeat: { type: "string", default: "1" },
    model: { type: "string" },
    threshold: { type: "string", default: "0.65" },
    "timeout-ms": { type: "string", default: "3000" },
    "input-usd-per-million": { type: "string" },
    "output-usd-per-million": { type: "string" },
  },
});

const repeat = Number(values.repeat);
const threshold = Number(values.threshold);
const timeout = Number(values["timeout-ms"]);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
  throw new Error("--repeat must be an integer from 1 to 20.");
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
  throw new Error("--threshold must be between 0 and 1.");
if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647)
  throw new Error("--timeout-ms must be a valid positive timer duration.");
const priceInput = values["input-usd-per-million"];
const priceOutput = values["output-usd-per-million"];
if ((priceInput === undefined) !== (priceOutput === undefined))
  throw new Error("Provide both token prices or neither.");
const prices =
  priceInput === undefined
    ? undefined
    : { input: Number(priceInput), output: Number(priceOutput) };
if (
  prices &&
  (!Number.isFinite(prices.input) ||
    !Number.isFinite(prices.output) ||
    prices.input < 0 ||
    prices.output < 0)
)
  throw new Error("Token prices must be nonnegative finite numbers.");
if (!values.live) {
  console.log(
    JSON.stringify(
      {
        mode: "preview",
        cases: cases.map((c) => c.id),
        skills: catalog.length,
        maxRequests: cases.length * repeat,
        config: {
          threshold,
          timeoutMs: timeout,
          model: values.model ?? "SDK default",
        },
        note: "Use --live to call Jev; no accuracy or latency is measured in preview mode.",
      },
      null,
      2,
    ),
  );
} else {
  if (!process.env.TYPESAFE_API_KEY?.trim())
    throw new Error("TYPESAFE_API_KEY is missing; no live requests were made.");
  const config = {
    ...DEFAULT_CONFIG,
    pinnedSkillPaths: [],
    minProbability: threshold,
    routeTimeoutMs: timeout,
    ...(values.model ? { model: values.model } : {}),
  };
  const evaluate = createJevEvaluator();
  const rows: EvaluationRow[] = [];
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  const startedAt = new Date().toISOString();
  for (let attempt = 1; attempt <= repeat; attempt++) {
    for (const task of cases) {
      const previous = catalog.filter((s) => task.previous?.includes(s.name));
      const result = await route(
        {
          catalog,
          pinned: [],
          state: buildRoutingState(
            task.prompt,
            task.history ?? [],
            previous,
            config,
          ),
          config,
          signal: undefined,
          issues: [],
        },
        evaluate,
      );
      rows.push({
        caseId: task.id,
        attempt,
        required: task.required,
        allowed: task.allowed,
        selected: result.skills.map((s) => s.name),
        report: result.report,
      });
      // Persist partial evidence after each bounded request; never save credentials.
      const report = {
        mode: "live-synthetic-metadata",
        startedAt,
        config,
        summary: summarize(rows, prices),
        limitations: [
          "Synthetic metadata suite; not a real installed catalog or task execution benchmark.",
          "Task completion and cache behavior require separate measurement.",
          "Total billed cost is unknown without complete usage and supplied prices; failures may incur charges.",
        ],
        rows,
      };
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        `${task.id} #${attempt}: ${result.report.status}${result.report.reason ? ` (${result.report.reason})` : ""}, ${Math.round(result.report.elapsedMs)} ms, selected=${result.skills.map((s) => s.name).join(",") || "none"}`,
      );
      if (
        result.report.reason === "authentication" ||
        result.report.reason === "missing_key" ||
        result.report.reason === "rate_limit" ||
        (result.report.httpStatus !== undefined &&
          result.report.httpStatus >= 400 &&
          result.report.httpStatus < 500)
      ) {
        console.error(
          `Stopped after ${result.report.reason}; partial evidence: ${output}`,
        );
        process.exitCode = 1;
        break;
      }
    }
    if (process.exitCode) break;
  }
  console.log(JSON.stringify(summarize(rows, prices), null, 2));
  console.log(`Report: ${output}`);
  if (rows.some((row) => row.report.status !== "selected"))
    process.exitCode = 1;
}
