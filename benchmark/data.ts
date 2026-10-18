import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { Query, SkillMapping } from "./types.ts";

export const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8"));
}
export async function jsonl<T>(path: string): Promise<T[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export function contained(root: string, path: string) {
  const resolved = resolve(root, path);
  const child = relative(root, resolved);
  if (
    child === ".." ||
    child.startsWith("../") ||
    child.startsWith("..\\") ||
    isAbsolute(child)
  )
    throw new Error("benchmark_path_escape");
  return resolved;
}
export async function loadSkillret(data: string) {
  const manifest = await json<{
    skillret: {
      files: Record<string, string>;
      mappingSha256: string;
      skills: number;
      queries: number;
    };
  }>(resolve(data, "manifest.json"));
  const base = resolve(data, "skillret");
  const spec = manifest.skillret;
  if (!spec) throw new Error("Run benchmark:prepare before preflight");
  for (const [file, hash] of Object.entries(spec.files)) {
    if (sha256(await readFile(contained(base, file))) !== hash)
      throw new Error("benchmark_source_hash_mismatch");
  }
  const mappingPath = resolve(base, "mapping.json");
  if (sha256(await readFile(mappingPath)) !== spec.mappingSha256)
    throw new Error("benchmark_mapping_hash_mismatch");
  const mapping = await json<SkillMapping[]>(mappingPath);
  const byFile = new Map<string, string>();
  for (const skill of mapping) {
    const path = contained(data, skill.path);
    if (sha256(await readFile(path)) !== skill.sha256)
      throw new Error("benchmark_skill_hash_mismatch");
    byFile.set(path, skill.id);
  }
  const native = loadSkillsFromDir({
    dir: resolve(base, "pi-skills"),
    source: "skillret-pinned-test",
  });
  if (
    native.skills.length !== spec.skills ||
    native.skills.some(
      (s) => s.disableModelInvocation || !byFile.has(resolve(s.filePath)),
    )
  )
    throw new Error("benchmark_catalog_loss");
  const queries = await jsonl<Query>(resolve(base, "data/queries/test.jsonl"));
  const ids = new Set(mapping.map((s) => s.id));
  if (
    queries.length !== spec.queries ||
    queries.some(
      (q) => !q.skill_ids.length || !q.skill_ids.every((id) => ids.has(id)),
    )
  )
    throw new Error("benchmark_query_mismatch");
  return {
    catalog: native.skills,
    byFile,
    queries,
    diagnostics: native.diagnostics.length,
  };
}
