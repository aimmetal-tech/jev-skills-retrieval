import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_BASE_URL,
  normalizeBaseUrl,
  resolveBaseUrl,
  saveProjectBaseUrl,
} from "../src/base-url.ts";
import { loadConfig } from "../src/config.ts";

test("Jev API roots normalize gateway prefixes and reject unsafe or non-HTTP URLs without echoing input", () => {
  assert.equal(
    normalizeBaseUrl(" https://EXAMPLE.com/gateway/// "),
    "https://example.com/gateway",
  );
  assert.equal(
    normalizeBaseUrl("http://127.0.0.1:7688"),
    "http://127.0.0.1:7688",
  );
  for (const value of [
    "",
    "  ",
    undefined,
    5,
    "ftp://example.com",
    "https:example.com",
    "https://secret-user:secret-pass@example.com",
    "https://example.com?key=secret",
    "https://example.com#secret",
    "https://example.com\\secret",
    "https://exa\nmple.com",
    "https://example.com/\0secret",
  ]) {
    assert.throws(
      () => normalizeBaseUrl(value),
      (error: unknown) =>
        error instanceof Error && !/secret/.test(error.message),
    );
  }
});

test("configured API roots take precedence over environment and default roots", () => {
  assert.equal(
    resolveBaseUrl("https://config.example/", "https://env.example"),
    "https://config.example",
  );
  assert.equal(
    resolveBaseUrl(undefined, " https://env.example/ "),
    "https://env.example",
  );
  assert.equal(resolveBaseUrl(undefined, " "), DEFAULT_BASE_URL);
  assert.throws(() =>
    resolveBaseUrl(undefined, "https://user:secret@example.com"),
  );
});

test("project endpoint saves preserve configuration, survive reload and reset to the user endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-base-url-"));
  try {
    saveProjectBaseUrl(root, undefined);
    assert.deepEqual(await readdir(root), []);
    saveProjectBaseUrl(root, "https://project.example/prefix/");
    const file = join(root, ".pi", "skill-router.json");
    const config = {
      ...JSON.parse(await readFile(file, "utf8")),
      model: "jev-1.14.0",
      maxAutoSkills: 2,
      pinnedSkillPaths: ["./skills/a/SKILL.md"],
    };
    await writeFile(file, JSON.stringify(config));
    saveProjectBaseUrl(root, "https://other.example/");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      ...config,
      baseUrl: "https://other.example",
    });
    const agent = join(root, ".pi");
    // The user layer uses the same schema; project values win while present.
    const userRoot = join(root, "user");
    saveProjectBaseUrl(userRoot, "https://user.example");
    const userAgent = join(userRoot, ".pi");
    assert.equal(
      loadConfig(root, userAgent).config.baseUrl,
      "https://other.example",
    );
    saveProjectBaseUrl(root, undefined);
    assert.equal(
      loadConfig(root, userAgent).config.baseUrl,
      "https://user.example",
    );
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      model: config.model,
      maxAutoSkills: 2,
      pinnedSkillPaths: config.pinnedSkillPaths,
    });
    assert.deepEqual((await readdir(agent)).sort(), ["skill-router.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid endpoint input and malformed existing JSON never overwrite project configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-base-error-"));
  try {
    saveProjectBaseUrl(root, "https://before.example");
    const file = join(root, ".pi", "skill-router.json");
    const before = await readFile(file, "utf8");
    assert.throws(() =>
      saveProjectBaseUrl(root, "https://example.com?secret=key"),
    );
    assert.equal(await readFile(file, "utf8"), before);
    for (const text of ["{broken", "[]", "null", '"text"']) {
      await writeFile(file, text);
      assert.throws(() => saveProjectBaseUrl(root, "https://after.example"));
      assert.throws(() => saveProjectBaseUrl(root, undefined));
      assert.equal(await readFile(file, "utf8"), text);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid configured endpoints produce sanitized config issues before routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-base-config-"));
  try {
    saveProjectBaseUrl(root, "https://valid.example");
    await writeFile(
      join(root, ".pi", "skill-router.json"),
      JSON.stringify({
        baseUrl: "https://secret-user:secret-pass@example.com",
      }),
    );
    const loaded = loadConfig(root, join(root, "agent"));
    assert.equal(loaded.config.baseUrl, undefined);
    assert.equal(loaded.issues.length, 1);
    assert.match(loaded.issues[0] ?? "", /Invalid baseUrl/);
    assert.doesNotMatch(loaded.issues.join(), /secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
