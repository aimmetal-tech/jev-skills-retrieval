import { execFile } from "node:child_process";
import { join } from "node:path";
import { getNativeClipboard } from "@earendil-works/pi-tui";

/** Read text only, on an explicit paste action. Never log clipboard output/errors. */
export async function readClipboardText(): Promise<string | undefined> {
  try {
    const text = await getNativeClipboard()?.getText();
    if (text !== undefined) return text ?? undefined;
  } catch {
    // Some Pi distributions lack a working native helper; try the OS tools.
  }
  const commands: Array<[string, string[]]> = [];
  if (process.platform === "win32") {
    commands.push([
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.Write((Get-Clipboard -Raw))",
      ],
    ]);
  } else if (process.platform === "darwin") {
    commands.push(["pbpaste", []]);
  } else {
    if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
    if (process.env.WAYLAND_DISPLAY)
      commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
    if (process.env.DISPLAY)
      commands.push(
        ["xclip", ["-selection", "clipboard", "-out"]],
        ["xsel", ["--clipboard", "--output"]],
      );
  }
  for (const [command, args] of commands) {
    const text = await new Promise<string | undefined>((resolve) => {
      execFile(
        command,
        args,
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 64 * 1024,
        },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    });
    if (text !== undefined) return text;
  }
  return undefined;
}
