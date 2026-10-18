import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { normalize, resolve } from "node:path";
import {
  formatSkillsForPrompt,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "./config.ts";

export interface Candidate {
  id: string;
  name: string;
  description: string;
  skill: Skill;
}

export type SkillIdentity = (filePath: string) => string;

/** One request only: a later request must observe changed symlinks/files. */
export function createSkillIdentityResolver(
  resolveIdentity: SkillIdentity = skillIdentity,
): SkillIdentity {
  const identities = new Map<string, string>();
  return (filePath) => {
    const key = resolve(filePath);
    let identity = identities.get(key);
    if (identity === undefined) {
      identity = resolveIdentity(key);
      identities.set(key, identity);
    }
    return identity;
  };
}

export interface CatalogSnapshot {
  catalog: Skill[];
  pinned: Skill[];
  candidates: Candidate[];
  issues: string[];
  merge: (skills: readonly Skill[]) => Skill[];
}

export function prepareCatalog(
  skills: readonly Skill[],
  options: {
    pinned?: readonly Skill[];
    pinnedPaths?: readonly string[];
    identity?: SkillIdentity;
  } = {},
): CatalogSnapshot {
  const identity = createSkillIdentityResolver(options.identity);
  const catalog = uniqueSkills(skills, identity);
  const pinned = options.pinnedPaths
    ? pinnedSkills(catalog, options.pinnedPaths, identity)
    : { skills: uniqueSkills(options.pinned ?? [], identity), issues: [] };
  return {
    catalog,
    pinned: pinned.skills,
    candidates: autoCandidates(catalog, pinned.skills, identity),
    issues: pinned.issues,
    merge: (items) => uniqueSkills(items, identity),
  };
}

export function autoCandidates(
  catalog: readonly Skill[],
  pinned: readonly Skill[],
  identity: SkillIdentity = createSkillIdentityResolver(),
): Candidate[] {
  const fixed = new Set(pinned.map((s) => identity(s.filePath)));
  return uniqueSkills(catalog, identity)
    .filter(
      (s) => !s.disableModelInvocation && !fixed.has(identity(s.filePath)),
    )
    .map((skill) => ({
      id: `skill_${createHash("sha256").update(identity(skill.filePath)).digest("hex")}`,
      name: skill.name,
      description: skill.description,
      skill,
    }));
}

export function selectAutomatic(
  candidates: readonly Candidate[],
  probabilities: Readonly<Record<string, number>>,
  config: RouterConfig,
  fileReadTool: "read" | "bash" | "indirect" = "read",
): Skill[] {
  const ranked = candidates
    .filter(
      (candidate) =>
        (probabilities[candidate.id] ?? -1) >= config.minProbability,
    )
    .sort(
      (a, b) =>
        (probabilities[b.id] ?? 0) - (probabilities[a.id] ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const selected: Skill[] = [];
  for (const candidate of ranked) {
    if (selected.length >= config.maxAutoSkills) break;
    const next = [...selected, candidate.skill];
    if (
      formatSkillsForPrompt(next, fileReadTool).length <=
      config.autoMetadataMaxChars
    )
      selected.push(candidate.skill);
  }
  return selected;
}

/** Local identity only. Never resolve paths supplied by a model response. */
export function skillIdentity(filePath: string): string {
  let path = resolve(filePath);
  try {
    path = realpathSync.native(path);
  } catch {
    // Missing paths are diagnosed by pinned selection, not hidden here.
  }
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function uniqueSkills(
  skills: readonly Skill[],
  identity: SkillIdentity = createSkillIdentityResolver(),
): Skill[] {
  const identities = new Set<string>();
  return skills.filter((skill) => {
    const key = identity(skill.filePath);
    if (identities.has(key)) return false;
    identities.add(key);
    return true;
  });
}

export function pinnedSkills(
  catalog: readonly Skill[],
  paths: readonly string[],
  identity: SkillIdentity = createSkillIdentityResolver(),
): { skills: Skill[]; issues: string[] } {
  if (paths.length === 0) return { skills: [], issues: [] };
  const byPath = new Map(
    catalog.map((skill) => [identity(skill.filePath), skill]),
  );
  const skills: Skill[] = [];
  const issues: string[] = [];
  for (const path of paths) {
    let exists = false;
    try {
      exists = statSync(path).isFile();
    } catch {
      /* Missing paths are diagnosed below. */
    }
    const skill = exists ? byPath.get(identity(path)) : undefined;
    if (skill) skills.push({ ...skill, disableModelInvocation: false });
    else issues.push(`Pinned skill is not in the Pi catalog: ${path}`);
  }
  return { skills: uniqueSkills(skills, identity), issues };
}
