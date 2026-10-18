import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const python = resolve(
  root,
  "outputs/benchmark/.venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
for (const args of [
  ["-m", "ruff", "check", "benchmark"],
  ["-m", "ruff", "format", "--check", "benchmark"],
  ["-m", "unittest", "discover", "-s", "benchmark", "-p", "test_*.py"],
]) {
  const code = await new Promise<number | null>((done, reject) => {
    const process = spawn(python, ["-X", "utf8", ...args], {
      cwd: root,
      windowsHide: true,
      stdio: "inherit",
    });
    process.on("error", reject);
    process.on("exit", done);
  });
  if (code !== 0) {
    process.exitCode = 1;
    break;
  }
}
