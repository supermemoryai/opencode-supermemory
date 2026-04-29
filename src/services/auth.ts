import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir, hostname, platform, arch } from "node:os";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

const CREDENTIALS_DIR = join(homedir(), ".supermemory-opencode");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");
const AUTH_BASE_URL = process.env.SUPERMEMORY_AUTH_URL || "https://console.supermemory.ai/auth/agent-connect";
const AUTH_TIMEOUT = Number(process.env.SUPERMEMORY_AUTH_TIMEOUT) || 60_000;

interface Credentials {
  apiKey: string;
  createdAt: string;
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    const content = readFileSync(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(content) as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(apiKey: string): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  const credentials: Credentials = {
    apiKey,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

export function clearCredentials(): boolean {
  if (!existsSync(CREDENTIALS_FILE)) return false;
  rmSync(CREDENTIALS_FILE);
  return true;
}

function openBrowser(url: string): void {
  const onError = (err: Error | null) => {
    if (err) console.error("Failed to open browser:", err.message);
  };
  if (process.platform === "win32") {
    execFile("explorer.exe", [url], onError);
  } else if (process.platform === "darwin") {
    execFile("open", [url], onError);
  } else {
    execFile("xdg-open", [url], onError);
  }
}

export interface AuthResult {
  success: boolean;
  apiKey?: string;
  error?: string;
}

export function startAuthFlow(): Promise<AuthResult> {
  return new Promise((resolve) => {
    let resolved = false;
    const stateToken = randomBytes(16).toString("hex");

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (resolved) return;

      const url = new URL(req.url || "/", "http://localhost");

      if (url.pathname === "/callback") {
        const callbackState = url.searchParams.get("state");
        if (callbackState !== stateToken) {
          res.writeHead(403, { "Content-Type": "text/html" });
          res.end(errorHtml("Invalid state token"));
          return;
        }

        const apiKey = url.searchParams.get("apikey") || url.searchParams.get("api_key");

        if (apiKey?.startsWith("sm_")) {
          saveCredentials(apiKey);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(successHtml);
          resolved = true;
          clearTimeout(timer);
          server.close();
          resolve({ success: true, apiKey });
        } else {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorHtml("No API key received"));
          resolved = true;
          clearTimeout(timer);
          server.close();
          resolve({ success: false, error: "No API key received" });
        }
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });

    server.on("error", (err: Error) => {
      if (!resolved) {
        clearTimeout(timer);
        resolve({ success: false, error: err.message });
      }
    });

    // Listen on an ephemeral port; embed state token in callback URL so the
    // console redirects it back and the CSRF check passes.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const callbackUrl = `http://localhost:${port}/callback?state=${stateToken}`;
      const params = new URLSearchParams({
        callback: callbackUrl,
        client: "opencode",
        hostname: hostname(),
        os: `${platform()}-${arch()}`,
        cwd: process.cwd(),
        cli_version: "1.0.0",
      });
      const authUrl = `${AUTH_BASE_URL}?${params.toString()}`;

      console.log("Opening browser for authentication...");
      console.log(`If it doesn't open, visit: ${authUrl}`);
      openBrowser(authUrl);
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.close();
        resolve({ success: false, error: "Authentication timed out" });
      }
    }, AUTH_TIMEOUT);
  });
}

const successHtml = `<!DOCTYPE html>
<html>
<head><title>Success</title></head>
<body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;">
  <div style="text-align: center;">
    <h1 style="color: #22c55e;">✓ Connected!</h1>
    <p>You can close this window and return to your terminal.</p>
  </div>
</body>
</html>`;

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;">
  <div style="text-align: center;">
    <h1 style="color: #ef4444;">✗ Connection Failed</h1>
    <p>${message}. Please try again.</p>
  </div>
</body>
</html>`;
}
