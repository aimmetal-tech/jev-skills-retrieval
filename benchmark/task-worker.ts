import { mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { skillIdentity } from "../src/selection.ts";
import { Budget } from "./budget.ts";
import { runPiTrial } from "./pi.ts";
import { JsonBridge, remoteTools, sandboxPath } from "./remote.ts";
import { createBenchmarkTransport } from "./transport.ts";
import type { Group, Limits } from "./types.ts";

const bridge = new JsonBridge();
let transport: ReturnType<typeof createBenchmarkTransport> | undefined;
const originalFetch = globalThis.fetch;
try {
  const init = (await bridge.first) as unknown as {
    virtualRoot: string;
    cwd: string;
    skills: string;
    taskId: string;
    group: Group;
    prompt: string;
    output: string;
    limits: Limits;
    model: string;
    gold: string[];
    evidence: "mock" | "live";
    nativeOAuth?: boolean;
  };
  const virtualRoot = resolve(init.virtualRoot);
  const cwd = resolve(virtualRoot, init.cwd.replace(/^\/+/, ""));
  await mkdir(cwd, { recursive: true });
  const skillRoot = resolve(virtualRoot, init.skills.replace(/^\/+/, ""));
  const loaded = loadSkillsFromDir({
    dir: skillRoot,
    source: "skillsbench-pinned-task",
  });
  if (loaded.diagnostics.some((d) => d.type === "collision"))
    throw new Error("skill_collision");
  const ids = new Map(
    loaded.skills.map((s) => [
      skillIdentity(s.filePath),
      relative(skillRoot, s.filePath).replaceAll("\\", "/"),
    ]),
  );
  for (const skill of loaded.skills) {
    const id = ids.get(skillIdentity(skill.filePath));
    if (id)
      ids.set(
        skillIdentity(resolve(cwd, sandboxPath(virtualRoot, skill.filePath))),
        id,
      );
  }
  const budget = new Budget(init.limits);
  if (init.evidence === "live") {
    transport = createBenchmarkTransport();
    globalThis.fetch = transport.fetch;
  }
  const row = await runPiTrial({
    suite: "skillsbench",
    caseId: init.taskId,
    group: init.group,
    prompt: init.prompt,
    gold: init.gold,
    catalog: loaded.skills,
    ids,
    cwd,
    agentDir: resolve(init.output, "agent-state"),
    model: init.model,
    ...(init.nativeOAuth ? { nativeOAuth: true } : {}),
    baseUrl: process.env.LLM_BASE_URL ?? "",
    apiKey: process.env.LLM_API_KEY ?? "",
    budget,
    ...(transport ? { transport: transport.fetch } : {}),
    customTools: remoteTools(virtualRoot, cwd, bridge.exec),
    checkpoint: resolve(init.output, "partial.json"),
    evidence: init.evidence,
    systemAppend: `Your tools operate in a Linux task sandbox. The actual shell working directory is ${init.cwd}. Paths shown in skill metadata are virtual host paths: use read for those files. For bash commands use POSIX sandbox paths. The skill root is ${init.skills}. Do not inspect oracle or verifier files.`,
  });
  process.stdout.write(
    `${JSON.stringify({ type: "result", row, stopped: budget.stopped ?? null })}\n`,
  );
} catch {
  process.stdout.write(
    `${JSON.stringify({ type: "error", code: "task_worker_failed" })}\n`,
  );
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  await transport?.close();
  bridge.lines.close();
}
