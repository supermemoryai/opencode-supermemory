import { appendFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LOG_FILE = join(homedir(), ".opencode-supermemory.log");

function writeLogLine(line: string): void {
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Logging must never prevent either OpenCode plugin generation from loading.
  }
}

try {
  writeFileSync(
    LOG_FILE,
    `\n--- Session started: ${new Date().toISOString()} ---\n`,
    { flag: "a" },
  );
} catch {
  // A read-only home directory should disable file logging, not the plugin.
}

export function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const line = data 
    ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${message}\n`;
  writeLogLine(line);
}
