import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("login keeps waiting for the callback when no browser can be opened", async () => {
  const oauth = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      const issuer = `http://127.0.0.1:${server.port}`;
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/.well-known/oauth-authorization-server":
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`,
            revocation_endpoint: `${issuer}/revoke`,
          });
        case "/register":
          return Response.json({ client_id: "test-client", token_endpoint_auth_method: "none" });
        case "/token":
          return Response.json({
            access_token: "test-access",
            refresh_token: "test-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          });
        default:
          return new Response(null, { status: 404 });
      }
    },
  });
  const issuer = `http://127.0.0.1:${oauth.port}`;
  const home = mkdtempSync(join(tmpdir(), "auth-home-"));
  const login = Bun.spawn([process.execPath, join(import.meta.dir, "../cli.ts"), "login"], {
    env: {
      HOME: home,
      PATH: mkdtempSync(join(tmpdir(), "no-opener-")),
      SUPERMEMORY_API_URL: issuer,
      SUPERMEMORY_OAUTH_ISSUER: issuer,
      SUPERMEMORY_MCP_URL: `${issuer}/mcp`,
      SUPERMEMORY_AUTH_TIMEOUT: "10000",
    },
    stdout: "pipe",
  });

  try {
    const reader = login.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (!output.includes("Open the URL above")) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }
    expect(output).toContain("Could not open a browser. Open the URL above to finish signing in.");
    const authorizationUrl = new URL(output.match(/visit: (\S+)/)![1]!);
    const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      code: "test-code",
      state: authorizationUrl.searchParams.get("state")!,
    }).toString();

    expect((await fetch(callback)).status).toBe(200);
    expect(await login.exited).toBe(0);
    const credentials = JSON.parse(
      readFileSync(join(home, ".supermemory-opencode", "credentials.json"), "utf-8"),
    );
    expect(credentials.accessToken).toBe("test-access");
  } finally {
    login.kill();
    oauth.stop(true);
  }
}, 15_000);
