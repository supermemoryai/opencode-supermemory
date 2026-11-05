import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf-8"));
  } catch {
    return false;
  }
}

// Base64 keeps & and quotes in the URL away from WSL interop and Windows command-line parsing.
function openWithPowerShell(href: string): Promise<void> {
  const script = `Start-Process '${href.replaceAll("'", "''")}'`;
  return run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
}

export async function openUrl(url: string | URL): Promise<void> {
  const href = url.toString();
  if (!/^https?:\/\//i.test(href)) {
    throw new Error("Refusing to open non-http URL");
  }

  if (process.platform === "win32") {
    try {
      await run("rundll32.exe", ["url.dll,FileProtocolHandler", href]);
      return;
    } catch {}

    await run("cmd.exe", ["/c", "start", '""', href]);
    return;
  }

  if (process.platform === "darwin") {
    await run("open", [href]);
    return;
  }

  if (isWsl()) {
    try {
      await run("wslview", [href]);
      return;
    } catch {}

    try {
      await openWithPowerShell(href);
      return;
    } catch {}
  }

  await run("xdg-open", [href]);
}
