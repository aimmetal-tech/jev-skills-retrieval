import type { CredentialStore } from "../src/credential-store.ts";

/** Existing fixtures never read/write the developer's real home or credentials. */
export class MemoryCredentialStore implements CredentialStore {
  readonly filePath = "test-user-home/.jev-skill-router/credentials.json";
  key: string | undefined;
  read(): string | undefined {
    return this.key;
  }
  save(key: string): void {
    this.key = key;
  }
  remove(): void {
    this.key = undefined;
  }
}
