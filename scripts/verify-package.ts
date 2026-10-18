import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const workspace = process.cwd();
const output = resolve(workspace, "outputs");
const temporaryRoot = resolve(workspace, ".tmp");
await mkdir(output, { recursive: true });
await mkdir(temporaryRoot, { recursive: true });
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this script through npm run verify:package");
const packOutput = execFileSync(
  process.execPath,
  [npmCli, "pack", "--json", "--pack-destination", output],
  { cwd: workspace, encoding: "utf8" },
);
const packed = JSON.parse(packOutput) as Array<{
  filename: string;
  files: Array<{ path: string }>;
}>;
const archive = packed[0];
assert(archive);
assert(archive.files.some((file) => file.path === "dist/pi-adapter.js"));
assert(archive.files.some((file) => file.path === "dist/pi-adapter.d.ts"));
assert(
  !archive.files.some((file) =>
    /^(?:src|tests|eval|outputs|node_modules|\.env|\.git)(?:\/|$)/.test(
      file.path,
    ),
  ),
);
const archivePath = resolve(output, archive.filename);
assert(
  archivePath.startsWith(`${output}${sep}`),
  "Archive must stay in outputs/",
);
const temporary = await mkdtemp(join(temporaryRoot, "package-smoke-"));
assert(temporary.startsWith(`${temporaryRoot}${sep}`));
try {
  execFileSync("tar", ["-xf", archivePath, "-C", temporary]);
  const packageRoot = join(temporary, "package");
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.dependencies["@typesafe-ai/sdk"], "0.7.0");
  assert.deepEqual(manifest.pi.extensions, ["./dist/pi-adapter.js"]);
  const loader = new DefaultResourceLoader({
    cwd: temporary,
    agentDir: join(temporary, "agent"),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: manifest.pi.extensions.map((entry: string) =>
      resolve(packageRoot, entry),
    ),
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert(loaded.extensions[0]?.handlers.has("before_agent_start"));
  assert(loaded.extensions[0]?.handlers.has("input"));
  const command = loaded.extensions[0]?.commands.get("jev-skill");
  assert(command, "Packed extension must register /jev-skill");
  const completions = await command.getArgumentCompletions?.("api");
  assert(completions?.some((item) => item.value === "apikey"));
  console.log(
    `Verified ${archive.filename}: ${archive.files.length} files; packed ESM extension loaded by Pi 1.3.0; no live API call.`,
  );
  console.log(`Package: ${archivePath}`);
} finally {
  // Only remove the unique directory created below the checked workspace root.
  assert(resolve(temporary).startsWith(`${temporaryRoot}${sep}`));
  await rm(temporary, { recursive: true, force: true });
}
