import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { skillIdentity } from "./selection.ts";

export interface RouterConfig {
  historyMaxTurns: number;
  historyMaxChars: number;
  maxAutoSkills: number;
  autoMetadataMaxChars: number;
  pinnedSkillPaths: string[];
  minProbability: number;
  routeTimeoutMs: number;
  model?: string;
}

export const DEFAULT_CONFIG: Readonly<RouterConfig> = Object.freeze({
  historyMaxTurns: 3,
  historyMaxChars: 8000,
  maxAutoSkills: 5,
  autoMetadataMaxChars: 4000,
  pinnedSkillPaths: [],
  minProbability: 0.65,
  routeTimeoutMs: 3000,
});

export interface LoadedConfig {
  config: RouterConfig;
  issues: string[];
}

const integerKeys = new Set([
  "historyMaxTurns",
  "historyMaxChars",
  "maxAutoSkills",
  "autoMetadataMaxChars",
  "routeTimeoutMs",
]);

export function loadConfig(cwd: string, agentDir: string): LoadedConfig {
  const config: RouterConfig = { ...DEFAULT_CONFIG, pinnedSkillPaths: [] };
  const issues: string[] = [];
  for (const file of [
    join(agentDir, "skill-router.json"),
    join(cwd, ".pi", "skill-router.json"),
  ]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        issues.push(`Cannot read configuration: ${file}`);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      issues.push(`Invalid JSON configuration: ${file}`);
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`Configuration must be an object: ${file}`);
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      const invalid = () => issues.push(`Invalid ${key} in ${file}`);
      if (integerKeys.has(key)) {
        const minimum = key === "routeTimeoutMs" ? 1 : 0;
        if (
          typeof item !== "number" ||
          !Number.isSafeInteger(item) ||
          item < minimum ||
          (key === "routeTimeoutMs" && item > 2147483647)
        )
          invalid();
        else Object.assign(config, { [key]: item });
      } else if (key === "minProbability") {
        if (
          typeof item !== "number" ||
          !Number.isFinite(item) ||
          item < 0 ||
          item > 1
        )
          invalid();
        else config.minProbability = item;
      } else if (key === "model") {
        if (typeof item !== "string" || !item.trim()) invalid();
        else config.model = item.trim();
      } else if (key === "pinnedSkillPaths") {
        if (!Array.isArray(item)) {
          invalid();
          continue;
        }
        for (const path of item) {
          if (typeof path !== "string" || !path.trim() || path.includes("\0")) {
            invalid();
            continue;
          }
          const expanded =
            path.startsWith("~/") || path.startsWith("~\\")
              ? join(homedir(), path.slice(2))
              : path;
          config.pinnedSkillPaths.push(resolve(dirname(file), expanded));
        }
      } else issues.push(`Unknown configuration field ${key} in ${file}`);
    }
  }
  config.pinnedSkillPaths = [
    ...new Map(
      config.pinnedSkillPaths.map((path) => [skillIdentity(path), path]),
    ).values(),
  ];
  return { config, issues };
}
