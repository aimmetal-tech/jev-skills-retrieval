import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";

/** Accept API roots, including gateway path prefixes, but never embedded secrets. */
export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Invalid base URL");
  const text = value.trim();
  if (!/^https?:\/\//i.test(text) || /[\s\p{Cc}?#\\]/u.test(text))
    throw new Error("Invalid base URL");
  const url = new URL(text);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new Error("Invalid base URL");
  return url.href.replace(/\/+$/, "");
}

export function resolveBaseUrl(
  configured?: string,
  environment: string | undefined = process.env.TYPESAFE_BASE_URL,
): string {
  return normalizeBaseUrl(
    configured ?? (environment?.trim() || DEFAULT_BASE_URL),
  );
}

/** Update only this project's endpoint, preserving all other configuration fields. */
export function saveProjectBaseUrl(
  cwd: string,
  value: string | undefined,
): void {
  const normalized = value === undefined ? undefined : normalizeBaseUrl(value);
  const file = join(cwd, ".pi", "skill-router.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Configuration must be an object");
    config = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (normalized === undefined) {
    if (!("baseUrl" in config)) return;
    delete config.baseUrl;
  } else config.baseUrl = normalized;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
