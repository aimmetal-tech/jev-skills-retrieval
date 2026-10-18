import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";

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
    const skill = byPath.get(skillIdentity(path));
    if (skill) skills.push({ ...skill, disableModelInvocation: false });
    else issues.push(`Pinned skill is not in the Pi catalog: ${path}`);
  }
  return { skills: uniqueSkills(skills), issues };
}
