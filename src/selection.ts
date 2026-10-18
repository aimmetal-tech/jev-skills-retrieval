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

export function autoCandidates(
  catalog: readonly Skill[],
  pinned: readonly Skill[],
): Candidate[] {
  const fixed = new Set(pinned.map((s) => skillIdentity(s.filePath)));
  return uniqueSkills(catalog)
    .filter(
      (s) => !s.disableModelInvocation && !fixed.has(skillIdentity(s.filePath)),
    )
    .map((skill) => ({
      id: `skill_${createHash("sha256").update(skillIdentity(skill.filePath)).digest("hex")}`,
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

export function uniqueSkills(skills: readonly Skill[]): Skill[] {
  const identities = new Set<string>();
  return skills.filter((skill) => {
    const identity = skillIdentity(skill.filePath);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

export function pinnedSkills(
  catalog: readonly Skill[],
  paths: readonly string[],
): { skills: Skill[]; issues: string[] } {
  const byPath = new Map(
    catalog.map((skill) => [skillIdentity(skill.filePath), skill]),
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
    const skill = exists ? byPath.get(skillIdentity(path)) : undefined;
    if (skill) skills.push({ ...skill, disableModelInvocation: false });
    else issues.push(`Pinned skill is not in the Pi catalog: ${path}`);
  }
  return { skills: uniqueSkills(skills), issues };
}
