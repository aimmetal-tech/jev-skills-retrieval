import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CredentialStore {
  readonly filePath: string;
  read(): string | undefined;
  save(apiKey: string): void;
  remove(): void;
}

export function credentialFile(home: string = homedir()): string {
  return join(home, ".jev-skill-router", "credentials.json");
}

export function validApiKey(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && !/\p{Cc}/u.test(value);
}

/** Public errors contain no file data, subprocess output or credential values. */
export class CredentialStoreError extends Error {
  constructor() {
    super("Cannot read or save the Jev credential file.");
  }
}

function protectForCurrentUser(value: string, decrypt = false): string {
  const method = decrypt ? "Unprotect" : "Protect";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$credentialBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
    `$protectedBytes = [Security.Cryptography.ProtectedData]::${method}($credentialBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($protectedBytes))",
  ].join("\n");
  // Secret bytes go through stdin, never through command arguments or a shell.
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const output = execFileSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: decrypt ? value : Buffer.from(value, "utf8").toString("base64"),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();
  if (!output || !/^[A-Za-z0-9+/]+={0,2}$/.test(output))
    throw new CredentialStoreError();
  return decrypt ? Buffer.from(output, "base64").toString("utf8") : output;
}

/** Windows uses user-bound DPAPI; POSIX uses a private directory and 0600 file. */
export class FileCredentialStore implements CredentialStore {
  constructor(readonly filePath: string = credentialFile()) {}

  read(): string | undefined {
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CredentialStoreError();
    }
    try {
      const record: unknown = JSON.parse(text);
      if (!record || typeof record !== "object" || Array.isArray(record))
        throw new CredentialStoreError();
      const entry = record as Record<string, unknown>;
      const protection =
        process.platform === "win32" ? "windows-dpapi" : "permissions";
      if (
        entry.version !== 1 ||
        entry.protection !== protection ||
        typeof entry.value !== "string"
      )
        throw new CredentialStoreError();
      const key =
        process.platform === "win32"
          ? protectForCurrentUser(entry.value, true)
          : entry.value;
      if (!validApiKey(key)) throw new CredentialStoreError();
      return key.trim();
    } catch {
      throw new CredentialStoreError();
    }
  }

  save(apiKey: string): void {
    let temporary: string | undefined;
    try {
      if (!validApiKey(apiKey)) throw new CredentialStoreError();
      const directory = dirname(this.filePath);
      const value =
        process.platform === "win32"
          ? protectForCurrentUser(apiKey.trim())
          : apiKey.trim();
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") chmodSync(directory, 0o700);
      temporary = join(directory, `.credentials-${randomUUID()}.tmp`);
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: 1, protection: process.platform === "win32" ? "windows-dpapi" : "permissions", value }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      renameSync(temporary, this.filePath);
    } catch {
      throw new CredentialStoreError();
    } finally {
      if (temporary) {
        try {
          rmSync(temporary, { force: true });
        } catch {
          /* Never expose subprocess/file errors. */
        }
      }
    }
  }

  remove(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      throw new CredentialStoreError();
    }
  }
}
