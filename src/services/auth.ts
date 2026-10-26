import * as fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { openUrl } from "./openUrl.js";
import { PLUGIN_VERSION } from "../version.js";

const CREDENTIALS_DIR = join(homedir(), ".supermemory-opencode");
export const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");
export const CLIENT_FILE = join(CREDENTIALS_DIR, "oauth-client.json");
const LOCK_FILE = join(CREDENTIALS_DIR, "auth.lock");
const AUTH_PORT = 19880;
const REDIRECT_URI = `http://127.0.0.1:${AUTH_PORT}/callback`;
const OAUTH_SCOPE = "openid profile email offline_access";
const REFRESH_TIMEOUT = 3000;
const REFRESH_REQUEST_TIMEOUT = 10_000;
const REFRESH_SKEW = 60_000;
const configuredAuthTimeout = Number(process.env.SUPERMEMORY_AUTH_TIMEOUT);
const AUTH_TIMEOUT =
  Number.isFinite(configuredAuthTimeout) && configuredAuthTimeout > 0
    ? configuredAuthTimeout
    : 5 * 60_000;

function callbackPage(title: string, color: string, heading: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title} - Supermemory</title></head>
<body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;">
<div style="text-align: center;"><h1 style="color: ${color};">${heading}</h1><p>${message}</p></div>
</body></html>`;
}

const AUTH_SUCCESS_HTML = callbackPage(
  "Connected",
  "#22c55e",
  "Connected!",
  "You can close this window and return to OpenCode.",
);
const AUTH_DENIED_HTML = callbackPage(
  "Authorization denied",
  "#ef4444",
  "Authorization denied",
  "Supermemory was not connected. Return to OpenCode and run login again to retry.",
);
const AUTH_FAILED_HTML = callbackPage(
  "Connection failed",
  "#ef4444",
  "Connection failed",
  "Return to OpenCode and try login again.",
);

export interface OAuthConfig {
  apiBaseUrl: string;
  issuer: string;
  resource: string;
}

interface OAuthClient extends OAuthConfig {
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
}

export interface OAuthCredentials extends OAuthClient {
  type: "oauth";
  accessToken?: string;
  refreshToken?: string;
  expiresAt: number;
  savedAt?: string;
}

export interface ApiKeyCredentials {
  type?: undefined;
  apiKey: string;
  apiBaseUrl?: string;
  createdAt?: string;
}

export type Credentials = OAuthCredentials | ApiKeyCredentials;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function isAuthRequired(error: unknown): boolean {
  return error instanceof AuthError && error.code === "AUTH_REQUIRED";
}

export function authRequired(): AuthError {
  return new AuthError(
    "Supermemory authentication required. Run `bunx opencode-supermemory@latest login` (or /supermemory-login), or set SUPERMEMORY_API_KEY.",
    "AUTH_REQUIRED",
  );
}

function readJson<T>(file: string): T | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf-8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

// OpenCode checks auth on every plugin event; skip re-parsing an unchanged file.
// Writes replace the file by rename, so the inode/size/mtime key changes.
let credentialCache: { key: string; data: Credentials | null } | undefined;

export function loadCredentialData(): Credentials | null {
  let key: string;
  try {
    const stat = fs.statSync(CREDENTIALS_FILE);
    key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    credentialCache = undefined;
    return null;
  }
  if (credentialCache?.key !== key) {
    const data = readJson<Credentials>(CREDENTIALS_FILE);
    credentialCache = {
      key,
      data:
        data?.type === "oauth" || (data && typeof data.apiKey === "string" && data.apiKey)
          ? data
          : null,
    };
  }
  return credentialCache.data ? { ...credentialCache.data } : null;
}

// Never return an OAuth token to a synchronous caller: it may need a refresh first.
export function loadCredentials(): string | undefined {
  const data = loadCredentialData();
  return data?.type === "oauth" ? undefined : data?.apiKey;
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// The OpenCode plugin process and CLI commands share these files. Reclaim only a
// lock whose owner is gone, and use a hard link to serialize reclamation of that inode.
function recoverAbandonedLock(): void {
  let recovery: string | undefined;
  let linked = false;
  try {
    const original = fs.statSync(LOCK_FILE);
    recovery = `${LOCK_FILE}.${original.dev}.${original.ino}.recovery`;
    fs.linkSync(LOCK_FILE, recovery);
    linked = true;
    const snapshot = fs.statSync(recovery);
    if (snapshot.ino !== original.ino || snapshot.dev !== original.dev) return;
    const owner = readJson<{ pid: number }>(recovery);
    let abandoned = false;
    if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        abandoned = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    } else {
      abandoned = Date.now() - snapshot.mtimeMs > 10 * 60_000;
    }
    if (abandoned) {
      const current = fs.statSync(LOCK_FILE);
      if (current.ino === original.ino && current.dev === original.dev) fs.unlinkSync(LOCK_FILE);
    }
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    if (linked && recovery) fs.rmSync(recovery, { force: true });
  }
}

async function withAuthLock<T>(
  action: (remaining: number) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(LOCK_FILE, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      recoverAbandonedLock();
      if (Date.now() >= deadline) throw new Error("Supermemory authentication is busy. Try again.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    return await action(Math.max(1, deadline - Date.now()));
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(LOCK_FILE, { force: true });
  }
}

function secureUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("OAuth requires HTTPS (HTTP is allowed only for loopback development).");
  }
  return url.toString().replace(/\/+$/, "");
}

export function getOAuthConfig(baseUrl: string, issuer: string, mcpUrl: string): OAuthConfig {
  return {
    apiBaseUrl: secureUrl(baseUrl),
    issuer: secureUrl(issuer),
    resource: secureUrl(mcpUrl),
  };
}

function sameConfig(credentials: Partial<OAuthConfig> | null, config: OAuthConfig): boolean {
  return (
    credentials?.apiBaseUrl === config.apiBaseUrl &&
    credentials?.issuer === config.issuer &&
    credentials?.resource === config.resource
  );
}

export function hasOAuthCredentials(config: OAuthConfig): boolean {
  const credentials = loadCredentialData();
  return (
    credentials?.type === "oauth" &&
    sameConfig(credentials, config) &&
    (!!credentials.refreshToken ||
      (!!credentials.accessToken && credentials.expiresAt > Date.now() + REFRESH_SKEW))
  );
}

function issuerEndpoint(value: string, issuer: string): string {
  const endpoint = secureUrl(value);
  if (new URL(endpoint).origin !== new URL(issuer).origin) {
    throw new Error("OAuth endpoint does not belong to the configured issuer.");
  }
  return endpoint;
}

async function oauthRequest(
  url: string | URL,
  options: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...options, redirect: "error" });
  const body: unknown = await response.json().catch(() => null);
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    // Do not leak tokens or server response bodies through logs.
    const code = ["invalid_grant", "invalid_client", "access_denied"].includes(String(data.error))
      ? String(data.error)
      : "oauth_request_failed";
    throw new AuthError(
      `Supermemory authorization failed (${code}, HTTP ${response.status}).`,
      code,
    );
  }
  return data;
}

async function registerClient(config: OAuthConfig, signal: AbortSignal): Promise<OAuthClient> {
  const saved = readJson<OAuthClient>(CLIENT_FILE);
  if (sameConfig(saved, config) && saved?.clientId && saved.redirectUri === REDIRECT_URI)
    return saved;
  const issuer = new URL(config.issuer);
  const metadata = await oauthRequest(
    new URL(`/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, "")}`, issuer),
    { signal },
  );
  if (metadata.issuer !== config.issuer)
    throw new Error("OAuth discovery returned an unexpected issuer.");
  const authorizationEndpoint = issuerEndpoint(
    String(metadata.authorization_endpoint),
    config.issuer,
  );
  const tokenEndpoint = issuerEndpoint(String(metadata.token_endpoint), config.issuer);
  const registrationEndpoint = issuerEndpoint(
    String(metadata.registration_endpoint),
    config.issuer,
  );
  const revocationEndpoint = issuerEndpoint(String(metadata.revocation_endpoint), config.issuer);
  const registration = await oauthRequest(registrationEndpoint, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Supermemory for OpenCode",
      client_uri: "https://github.com/supermemoryai/opencode-supermemory",
      software_id: "opencode-supermemory",
      software_version: PLUGIN_VERSION,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPE,
    }),
  });
  if (
    typeof registration.client_id !== "string" ||
    !registration.client_id ||
    registration.token_endpoint_auth_method !== "none"
  ) {
    throw new Error("OAuth registration did not return a public client.");
  }
  const client: OAuthClient = {
    ...config,
    clientId: registration.client_id,
    redirectUri: REDIRECT_URI,
    authorizationEndpoint,
    tokenEndpoint,
    revocationEndpoint,
  };
  signal.throwIfAborted();
  writeJson(CLIENT_FILE, client);
  return client;
}

async function exchangeToken(
  client: OAuthClient,
  parameters: Record<string, string>,
  signal: AbortSignal,
  previous?: OAuthCredentials,
): Promise<string> {
  const data = await oauthRequest(issuerEndpoint(client.tokenEndpoint, client.issuer), {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      resource: client.resource,
      ...parameters,
    }),
  });
  const refreshToken = data.refresh_token ?? previous?.refreshToken;
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer" ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    typeof refreshToken !== "string" ||
    !refreshToken
  ) {
    throw new Error("OAuth returned an invalid token response.");
  }
  signal.throwIfAborted();
  const credentials: OAuthCredentials = {
    type: "oauth",
    apiBaseUrl: client.apiBaseUrl,
    issuer: client.issuer,
    resource: client.resource,
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    authorizationEndpoint: client.authorizationEndpoint,
    tokenEndpoint: client.tokenEndpoint,
    revocationEndpoint: client.revocationEndpoint,
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    savedAt: new Date().toISOString(),
  };
  writeJson(CREDENTIALS_FILE, credentials);
  return data.access_token;
}

// Never abort a refresh mid-flight: the server would rotate a refresh token we never
// stored, and the next refresh would fail with invalid_grant and sign the user out.
let pendingRefresh: Promise<string> | null = null;

function refreshCredentials(config: OAuthConfig): Promise<string> {
  if (pendingRefresh) return pendingRefresh;
  const refresh = withAuthLock(async (remaining) => {
    const credentials = loadCredentialData();
    if (credentials?.type !== "oauth" || !sameConfig(credentials, config)) throw authRequired();
    if (credentials.accessToken && credentials.expiresAt > Date.now() + REFRESH_SKEW)
      return credentials.accessToken;
    if (!credentials.refreshToken) throw authRequired();
    try {
      return await exchangeToken(
        credentials,
        {
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
        },
        AbortSignal.timeout(remaining),
        credentials,
      );
    } catch (error) {
      if (error instanceof AuthError && ["invalid_grant", "invalid_client"].includes(error.code)) {
        const { accessToken: _access, refreshToken: _refresh, ...registration } = credentials;
        writeJson(CREDENTIALS_FILE, registration);
        if (error.code === "invalid_client") fs.rmSync(CLIENT_FILE, { force: true });
        throw authRequired();
      }
      throw error;
    }
  }, REFRESH_REQUEST_TIMEOUT).finally(() => {
    pendingRefresh = null;
  });
  // Callers may stop waiting before the refresh settles.
  refresh.catch(() => {});
  pendingRefresh = refresh;
  return refresh;
}

// Bounds only how long the caller waits; the refresh itself keeps running.
function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      const error = new AuthError("Supermemory token refresh is still in progress.", "AUTH_PENDING");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export async function getAccessToken(
  config: OAuthConfig,
  timeoutMs = REFRESH_TIMEOUT,
): Promise<string> {
  const saved = loadCredentialData();
  if (saved?.type !== "oauth" || !sameConfig(saved, config)) throw authRequired();
  if (saved.accessToken && saved.expiresAt > Date.now() + REFRESH_SKEW) return saved.accessToken;
  return waitFor(refreshCredentials(config), timeoutMs);
}

// Await before an explicit exit so rotated tokens from an in-flight refresh are saved.
export async function settleAuth(): Promise<void> {
  while (pendingRefresh) {
    await pendingRefresh.catch(() => {});
  }
}

export async function clearCredentials(): Promise<Credentials | null> {
  return withAuthLock(async (remaining) => {
    const credentials = loadCredentialData();
    if (credentials?.type === "oauth" && credentials.refreshToken) {
      await oauthRequest(issuerEndpoint(credentials.revocationEndpoint, credentials.issuer), {
        method: "POST",
        signal: AbortSignal.timeout(remaining),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          token: credentials.refreshToken,
          token_type_hint: "refresh_token",
        }),
      });
    }
    fs.rmSync(CREDENTIALS_FILE, { force: true });
    return credentials;
  }, REFRESH_REQUEST_TIMEOUT);
}

export async function startAuthFlow(
  config: OAuthConfig,
  timeoutMs = AUTH_TIMEOUT,
  { printUrl = false }: { printUrl?: boolean } = {},
): Promise<string> {
  return withAuthLock(async (remaining) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Authentication timed out.")),
      remaining,
    );
    let server: Server | undefined;
    try {
      const client = await registerClient(config, controller.signal);
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const authorizationUrl = new URL(issuerEndpoint(client.authorizationEndpoint, client.issuer));
      authorizationUrl.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: OAUTH_SCOPE,
        resource: client.resource,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
        prompt: "consent",
      }).toString();
      return await new Promise<string>((resolve, reject) => {
        let exchanging = false;
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
        server = createServer(async (req, res) => {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Referrer-Policy", "no-referrer");
          let url: URL;
          try {
            url = new URL(req.url || "/", REDIRECT_URI);
          } catch {
            res.writeHead(400).end();
            return;
          }
          if (req.method !== "GET" || url.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          const receivedState = Buffer.from(url.searchParams.get("state") || "");
          if (
            receivedState.length !== state.length ||
            !timingSafeEqual(receivedState, Buffer.from(state)) ||
            (url.searchParams.has("iss") && url.searchParams.get("iss") !== client.issuer)
          ) {
            res.writeHead(400).end("Invalid authorization state.");
            return;
          }
          if (exchanging) {
            res.writeHead(409).end();
            return;
          }
          exchanging = true;
          try {
            if (url.searchParams.has("error")) {
              throw new AuthError("Authorization was denied.", "access_denied");
            }
            const code = url.searchParams.get("code");
            if (!code) throw new Error("Authorization code missing.");
            const token = await exchangeToken(
              client,
              {
                grant_type: "authorization_code",
                code,
                code_verifier: verifier,
                redirect_uri: REDIRECT_URI,
              },
              controller.signal,
            );
            res
              .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
              .end(AUTH_SUCCESS_HTML, () => resolve(token));
          } catch (error) {
            const denied = error instanceof AuthError && error.code === "access_denied";
            res
              .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
              .end(denied ? AUTH_DENIED_HTML : AUTH_FAILED_HTML);
            if (
              error instanceof AuthError &&
              error.code === "invalid_client" &&
              !controller.signal.aborted
            ) {
              fs.rmSync(CLIENT_FILE, { force: true });
            }
            reject(error);
          }
        });
        server.on("error", () =>
          reject(
            new Error(
              `Cannot open the authentication callback port ${AUTH_PORT}. Retry after other logins finish.`,
            ),
          ),
        );
        server.listen(AUTH_PORT, "127.0.0.1", () => {
          // The Supermemory CLI collects these links to approve several plugins on one consent screen.
          if (printUrl) {
            process.stdout.write(`SUPERMEMORY_AUTHORIZE_URL=${authorizationUrl.toString()}\n`);
            return;
          }
          console.log("Opening browser for authentication...");
          console.log(`If it doesn't open, visit: ${authorizationUrl.toString()}`);
          openUrl(authorizationUrl).catch(() =>
            reject(
              new Error("Failed to open the browser. Retry login from an interactive terminal."),
            ),
          );
        });
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      server?.close();
      server?.closeAllConnections();
    }
  }, timeoutMs);
}
