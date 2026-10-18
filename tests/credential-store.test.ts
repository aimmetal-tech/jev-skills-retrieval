import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CredentialStoreError,
  credentialFile,
  FileCredentialStore,
} from "../src/credential-store.ts";

test("credential path lives under the user's home independently of project cwd", () => {
  assert.equal(
    credentialFile(join(tmpdir(), "fake-user-home")),
    join(tmpdir(), "fake-user-home", ".jev-skill-router", "credentials.json"),
  );
});

test("saved file survives new instances, replaces atomically, enforces platform protection and can be reset", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-credential-home-"));
  try {
    const file = credentialFile(home);
    const store = new FileCredentialStore(file);
    assert.equal(store.read(), undefined);
    const key = "test-persisted-秘密-'-$()-key";
    store.save(key);
    const serialized = await readFile(file, "utf8");
    assert.equal(new FileCredentialStore(file).read(), key);
    const record = JSON.parse(serialized);
    if (process.platform === "win32") {
      assert.equal(record.protection, "windows-dpapi");
      assert(!serialized.includes(key));
    } else {
      assert.equal(record.protection, "permissions");
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal(
        (await stat(join(home, ".jev-skill-router"))).mode & 0o777,
        0o700,
      );
    }
    store.save("replacement-test-key");
    assert.equal(new FileCredentialStore(file).read(), "replacement-test-key");
    assert.deepEqual(await readdir(join(home, ".jev-skill-router")), [
      "credentials.json",
    ]);
    store.remove();
    assert.equal(new FileCredentialStore(file).read(), undefined);
    store.remove();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("invalid JSON, file versions and encrypted payloads fail without exposing credential file contents", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-credential-corrupt-"));
  try {
    const file = join(home, "credentials.json");
    const store = new FileCredentialStore(file);
    for (const value of [
      '{"secret": "must-not-echo"',
      "[]",
      JSON.stringify({ version: 2, value: "must-not-echo" }),
      JSON.stringify({
        version: 1,
        protection: "windows-dpapi",
        value: "must-not-echo",
      }),
    ]) {
      await writeFile(file, value);
      assert.throws(
        () => store.read(),
        (error: unknown) =>
          error instanceof CredentialStoreError &&
          !/must-not-echo/.test(error.message),
      );
      assert.equal(await readFile(file, "utf8"), value);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("invalid key saves preserve the previous credential bytes, while filesystem failures stay sanitized", async () => {
  const home = await mkdtemp(join(tmpdir(), "jev-credential-failure-"));
  try {
    const file = credentialFile(home);
    const store = new FileCredentialStore(file);
    store.save("previous-test-key");
    const before = await readFile(file, "utf8");
    for (const value of ["", " ", "secret\nvalue", "secret\0value"]) {
      assert.throws(() => store.save(value), CredentialStoreError);
      assert.equal(await readFile(file, "utf8"), before);
    }
    const blocker = join(home, "not-a-directory");
    await writeFile(blocker, "preserve-this-file");
    const blocked = new FileCredentialStore(join(blocker, "credentials.json"));
    assert.throws(
      () => blocked.save("failure-path-test-secret"),
      (error: unknown) =>
        error instanceof CredentialStoreError &&
        !error.message.includes("secret"),
    );
    assert.equal(await readFile(blocker, "utf8"), "preserve-this-file");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
