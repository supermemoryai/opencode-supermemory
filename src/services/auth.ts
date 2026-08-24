import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { arch, homedir, hostname, platform } from "node:os";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { openUrl } from "./openUrl.js";
import { PLUGIN_VERSION } from "../version.js";

const CREDENTIALS_DIR = join(homedir(), ".supermemory-opencode");
export const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");
const AUTH_BASE_URL = process.env.SUPERMEMORY_AUTH_URL || "https://app.supermemory.ai/auth/connect";
const AUTH_TIMEOUT = Number(process.env.SUPERMEMORY_AUTH_TIMEOUT) || 5 * 60_000;
const CLIENT_NAME = "opencode";

export interface Credentials {
  apiKey: string;
  apiBaseUrl?: string;
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

export function normalizeApiBaseUrl(apiBaseUrl: string | null | undefined): string | undefined {
  if (!apiBaseUrl) return undefined;
  try {
    const url = new URL(apiBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function saveCredentials(apiKey: string, apiBaseUrl?: string): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  const credentials: Credentials = {
    apiKey,
    createdAt: new Date().toISOString(),
  };
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  if (normalizedApiBaseUrl) credentials.apiBaseUrl = normalizedApiBaseUrl;

  const temporaryFile = join(
    CREDENTIALS_DIR,
    `.credentials-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporaryFile, JSON.stringify(credentials, null, 2), {
      mode: 0o600,
    });
    renameSync(temporaryFile, CREDENTIALS_FILE);
  } finally {
    if (existsSync(temporaryFile)) rmSync(temporaryFile);
  }
}

export function clearCredentials(): boolean {
  if (!existsSync(CREDENTIALS_FILE)) return false;
  rmSync(CREDENTIALS_FILE);
  return true;
}

export type AuthResult =
  | { success: true; apiKey: string; apiBaseUrl?: string }
  | { success: false; error: string };

export function startAuthFlow(timeoutMs = AUTH_TIMEOUT): Promise<AuthResult> {
  return new Promise((resolve) => {
    let resolved = false;
    const stateToken = randomBytes(16).toString("hex");

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (resolved) return;

      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (url.pathname === "/callback") {
        const callbackState = url.searchParams.get("state");
        if (callbackState !== stateToken) {
          res.writeHead(403, { "Content-Type": "text/html" });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Error</title></head>
            <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;">
              <div style="text-align: center;">
                <h1 style="color: #ef4444;">Connection Failed</h1>
                <p>Invalid auth state. Please try again.</p>
              </div>
            </body>
            </html>
          `);
          return;
        }

        const authError =
          url.searchParams.get("error_description") ||
          url.searchParams.get("error");
        if (authError) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Cancelled</title></head>
            <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;">
              <div style="text-align: center;">
                <h1>Connection Cancelled</h1>
                <p>Your existing credentials were not changed.</p>
              </div>
            </body>
            </html>
          `);
          resolved = true;
          clearTimeout(timer);
          server.close();
          resolve({ success: false, error: authError });
          return;
        }

        const apiKey = url.searchParams.get("apikey") || url.searchParams.get("api_key");
        const apiBaseUrl = url.searchParams.get("api_url") || url.searchParams.get("api_base_url");

        if (apiKey?.startsWith("sm_")) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Success</title></head>
            <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;">
              <div style="text-align: center;">
                <h1 style="color: #22c55e;">Authorization Received!</h1>
                <p>Return to your terminal to finish verification.</p>
              </div>
            </body>
            </html>
          `);
          resolved = true;
          clearTimeout(timer);
          server.close();
          resolve({
            success: true,
            apiKey,
            apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
          });
        } else {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Error</title></head>
            <body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;">
              <div style="text-align: center;">
                <h1 style="color: #ef4444;">Connection Failed</h1>
                <p>No API key received. Please try again.</p>
              </div>
            </body>
            </html>
          `);
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

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ success: false, error: err.message });
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const callbackUrl = `http://127.0.0.1:${port}/callback?state=${stateToken}`;
      const params = new URLSearchParams({
        callback: callbackUrl,
        client: CLIENT_NAME,
        hostname: `opencode - ${hostname()}`,
        os: `${platform()}-${arch()}`,
        cwd: process.cwd(),
        cli_version: PLUGIN_VERSION,
      });
      const authUrl = `${AUTH_BASE_URL}?${params.toString()}`;

      console.log("Opening browser for authentication...");
      console.log(`If it doesn't open, visit: ${authUrl}`);
      openUrl(authUrl).catch((error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          server.close();
          resolve({ success: false, error: `Failed to open browser: ${error.message}` });
        }
      });
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.close();
        resolve({ success: false, error: "Authentication timed out" });
      }
    }, timeoutMs);
  });
}
