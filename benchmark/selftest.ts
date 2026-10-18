/** Explicit Docker verification with a harmless fixture and loopback-only fake providers. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { subprocess, writeReport } from "./run.ts";
import type { Group, Trial } from "./types.ts";

const project = resolve(import.meta.dirname, "..");
const root = resolve(project, "outputs/benchmark/verification");
await mkdir(root, { recursive: true });
const output = await mkdtemp(resolve(root, "docker-"));
const task = resolve(output, "fixture");
for (const directory of ["environment/skills/answer", "oracle", "verifier"])
  await mkdir(resolve(task, directory), { recursive: true });
await writeFile(
  resolve(task, "task.md"),
  `---
schema_version: '1.3'
metadata:
  author_name: Jev benchmark verification
  difficulty: easy
  category: software-engineering
agent:
  timeout_sec: 60
verifier:
  type: test-script
  timeout_sec: 30
environment:
  workdir: /app
  cpus: 1
  memory_mb: 512
---
Read the answer skill and write the number 42 to /app/answer.txt.
`,
);
await writeFile(
  resolve(task, "environment/Dockerfile"),
  "FROM python:3.12-slim\nWORKDIR /app\n",
);
await writeFile(
  resolve(task, "environment/skills/answer/SKILL.md"),
  "---\nname: answer\ndescription: Write a simple numeric answer to a file.\n---\nBENIGN_FIXTURE_SKILL: The answer is 42.\n",
);
await writeFile(
  resolve(task, "oracle/solve.sh"),
  "#!/bin/sh\nprintf 42 > /app/answer.txt\n",
);
await writeFile(
  resolve(task, "verifier/test.sh"),
  '#!/bin/sh\nmkdir -p /logs/verifier\nif [ "$(cat /app/answer.txt 2>/dev/null)" = 42 ]; then printf 1 > /logs/verifier/reward.txt; else printf 0 > /logs/verifier/reward.txt; fi\n',
);

let piCalls = 0;
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  if (request.url === "/v1/systemone") {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        model: "jev-mock",
        answers: Object.fromEntries(
          Object.keys(payload.questions).map((id) => [
            id,
            { type: "noul", noul: 0.99 },
          ]),
        ),
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    );
    return;
  }
  piCalls++;
  const text = JSON.stringify(payload.messages);
  const stage = (piCalls - 1) % 3;
  const location = text
    .match(/<location>(.*?)<\/location>/)?.[1]
    ?.replaceAll("\\\\", "\\");
  // Exercise both the POSIX sandbox form and Pi's virtual host metadata form.
  const skillPath =
    piCalls <= 3 && location
      ? `/${location.split(/virtual-root[\\/]/)[1]?.replaceAll("\\", "/")}`
      : location;
  const delta =
    stage === 0
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "read-answer",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: skillPath }),
              },
            },
          ],
        }
      : stage === 1
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "write-answer",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: "printf 42 > /app/answer.txt",
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Done." };
  if (stage > 0) assert.match(text, /BENIGN_FIXTURE_SKILL/);
  response.setHeader("Content-Type", "text/event-stream");
  for (const [patch, finish] of [
    [delta, null],
    [{}, stage < 2 ? "tool_calls" : "stop"],
  ])
    response.write(
      `data: ${JSON.stringify({ id: "fixture", model: "mock", object: "chat.completion.chunk", created: 1, choices: [{ index: 0, delta: patch, finish_reason: finish }] })}\n\n`,
    );
  response.write(
    `data: ${JSON.stringify({ id: "fixture", model: "mock", choices: [], usage: { prompt_tokens: 30, completion_tokens: 5 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const python = resolve(
  project,
  "outputs/benchmark/.venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const rows: Trial[] = [];
try {
  for (const group of ["native", "router"] as Group[]) {
    const config = resolve(output, `${group}.json`);
    await writeFile(
      config,
      JSON.stringify({
        task,
        output: resolve(output, group),
        group,
        project,
        node: process.execPath,
        evidence: "mock",
        model: "openai-gpt-6-luna",
        limits: {
          maxRequests: 10,
          maxTotalTokens: 10000,
          maxTurns: 5,
          maxOutputTokens: 100,
          taskTimeoutMs: 60000,
        },
      }),
    );
    const result = JSON.parse(
      await subprocess(
        python,
        ["benchmark/skillsbench.py", config],
        (line) => process.stderr.write(line),
        {
          ...process.env,
          LLM_API_KEY: "loopback-fake",
          LLM_BASE_URL: `${base}/v1`,
          TYPESAFE_API_KEY: "loopback-fake",
          TYPESAFE_BASE_URL: base,
        },
      ),
    );
    assert.equal(result.row?.status, "completed", JSON.stringify(result));
    assert.equal(result.row.taskSuccess, true);
    assert.equal(result.row.reads.length, 1);
    assert.equal(result.row.pi.complete, true);
    assert.equal(result.row.evidence, "mock");
    rows.push(result.row);
    await writeFile(
      resolve(output, "results.jsonl"),
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
  }
  await writeFile(
    resolve(output, "run.json"),
    JSON.stringify(
      {
        evidence: "mock",
        fixture: "benign answer file",
        expectedPerGroup: { skillret: 0, skillsbench: 1 },
      },
      null,
      2,
    ),
  );
  await writeReport(output, rows, { skillret: 0, skillsbench: 1 }, false);
  await subprocess(python, ["benchmark/report.py", output]);
  console.log(
    `Docker/Pi/verifier bridge verified using MOCK providers only: ${output}`,
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
