import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createSkillRouterExtension } from "../src/pi-adapter.ts";

interface Payload {
  messages: Array<{ role: string; content: unknown }>;
}

async function harness(
  factory: (root: string) => ExtensionFactory,
  toolFirst = false,
) {
  const root = await mkdtemp(join(tmpdir(), "jev-pi-test-"));
  const payloads: Payload[] = [];
  const errors: unknown[] = [];
  for (const name of ["alpha", "beta", "pinned"]) {
    const dir = join(root, ".pi", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: UNIQUE_METADATA_${name.toUpperCase()}\n${name === "pinned" ? "disable-model-invocation: true\n" : ""}---\nUNIQUE_BODY_${name.toUpperCase()}\n`,
    );
  }
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body) as Payload);
    const toolCall = toolFirst && payloads.length === 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = toolCall
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "read-alpha",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({
                  path: join(root, ".pi", "skills", "alpha", "SKILL.md"),
                }),
              },
            },
          ],
        }
      : { role: "assistant", content: "Complete." };
    for (const [patch, finish] of [
      [delta, null],
      [{}, toolCall ? "tool_calls" : "stop"],
    ]) {
      res.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta: patch, finish_reason: finish }] })}\n\n`,
      );
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
  });
  const agentDir = join(root, "agent");
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("router-test", {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "local-test-only",
    api: "openai-completions",
    models: [
      {
        id: "mock",
        name: "Mock",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      },
    ],
  });
  const model = runtime.getModel("router-test", "mock");
  assert(model);
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [factory(root)],
  });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager,
    tools: ["read"],
    thinkingLevel: "off",
  });
  assert.deepEqual(extensionsResult.errors, []);
  await session.bindExtensions({
    onError: (error) => errors.push(error),
  });
  session.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error"
    ) {
      errors.push(event.message.errorMessage);
    }
  });
  return {
    session,
    payloads,
    errors,
    root,
    async close() {
      session.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

function payloadText(payload: Payload | undefined): string {
  assert(payload, "Expected an actual HTTP provider request");
  return JSON.stringify(payload.messages);
}

test("actual provider payload contains selected and pinned metadata; tool continuation reuses it", async () => {
  let routes = 0;
  const h = await harness(
    (root) =>
      createSkillRouterExtension({
        pinnedPaths: [join(root, ".pi", "skills", "pinned", "SKILL.md")],
        select: async ({ catalog }) => {
          routes++;
          return catalog.filter((s) => s.name === "alpha");
        },
      }),
    true,
  );
  try {
    await h.session.prompt("Work on alpha");
    assert.deepEqual(h.errors, []);
    assert.equal(routes, 1);
    assert.equal(
      h.payloads.length,
      2,
      "A real read tool causes a second request",
    );
    for (const payload of h.payloads) {
      const text = payloadText(payload);
      assert.match(text, /UNIQUE_METADATA_ALPHA/);
      assert.match(text, /UNIQUE_METADATA_PINNED/);
      assert.doesNotMatch(text, /UNIQUE_METADATA_BETA/);
    }
    assert.match(payloadText(h.payloads[1]), /UNIQUE_BODY_ALPHA/);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("explicit command body is loaded natively and raw input reaches the selector", async () => {
  let raw = "";
  const h = await harness(() =>
    createSkillRouterExtension({
      select: async (input) => {
        raw = input.rawText;
        return [];
      },
    }),
  );
  try {
    await h.session.prompt("/skill:pinned perform this");
    assert.deepEqual(h.errors, []);
    assert.equal(raw, "/skill:pinned perform this");
    const text = payloadText(h.payloads[0]);
    assert.match(text, /UNIQUE_BODY_PINNED/);
    assert.doesNotMatch(text, /UNIQUE_METADATA_ALPHA|UNIQUE_METADATA_BETA/);
    assert.match(
      await readFile(join(h.root, ".pi/skills/pinned/SKILL.md"), "utf8"),
      /disable-model-invocation: true/,
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
