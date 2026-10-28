import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_ENTITY_CONTEXT } from "./entity-context.js";

const CLIENT_MODULE = join(import.meta.dir, "client.ts");
const CONTEXT_MODULE = join(import.meta.dir, "entity-context.ts");
const NAMESPACE = "repo_demo__0123456789abcdef";

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

async function runClient(
  config: Record<string, unknown>,
): Promise<{ requests: RecordedRequest[]; captureContext: string }> {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text();
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: text ? JSON.parse(text) : undefined,
      });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const home = mkdtempSync(join(tmpdir(), "opencode-supermemory-"));
  try {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode", "supermemory.json"),
      JSON.stringify({ apiKey: "sm_test", baseUrl: server.url.origin, ...config }),
    );
    const env: Record<string, string | undefined> = { ...process.env, HOME: home };
    for (const name of [
      "SUPERMEMORY_API_KEY",
      "SUPERMEMORY_API_URL",
      "SUPERMEMORY_BASE_URL",
      "SUPERMEMORY_API_VERSION",
    ]) {
      delete env[name];
    }
    const script = `
      const { supermemoryClient } = await import(${JSON.stringify(CLIENT_MODULE)});
      await supermemoryClient.applyNamespaceContext(${JSON.stringify(NAMESPACE)});
      await supermemoryClient.applyNamespaceContext(${JSON.stringify(NAMESPACE)});
      await supermemoryClient.searchMemories("stack", ${JSON.stringify(NAMESPACE)});
      await Bun.sleep(100);
      const { SUPPORTING_CONTEXT } = await import(${JSON.stringify(CONTEXT_MODULE)});
      console.log(JSON.stringify(SUPPORTING_CONTEXT));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(await new Response(child.stderr).text());
    }
    const stdout = await new Response(child.stdout).text();
    return { requests, captureContext: JSON.parse(stdout.trim().split("\n").at(-1)!) };
  } finally {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}

function isOrgSettingsWrite(request: RecordedRequest): boolean {
  return request.path.includes("/settings") || request.path.startsWith("/organization");
}

describe("client startup", () => {
  test("v5 without a filterPrompt writes no settings", async () => {
    const { requests, captureContext } = await runClient({ apiVersion: "v5" });
    expect(captureContext).toBe(AGENT_ENTITY_CONTEXT);
    expect(requests.some(isOrgSettingsWrite)).toBe(false);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    expect(requests.some((request) => request.path === `/ns/${NAMESPACE}/search`)).toBe(true);
  }, 20_000);

  test("v5 with a filterPrompt patches only the plugin namespace, once", async () => {
    const { requests, captureContext } = await runClient({
      apiVersion: "v5",
      filterPrompt: "  Focus on build tooling decisions.  ",
    });
    expect(captureContext).toBe("Focus on build tooling decisions.");
    expect(requests.some(isOrgSettingsWrite)).toBe(false);
    const patches = requests.filter((request) => request.method === "PATCH");
    expect(patches).toEqual([
      {
        method: "PATCH",
        path: `/ns/${NAMESPACE}`,
        body: { supportingContext: "Focus on build tooling decisions." },
      },
    ]);
  }, 20_000);

  test("v5 ignores a filterPrompt over the 1500 character limit", async () => {
    const { requests, captureContext } = await runClient({
      apiVersion: "v5",
      filterPrompt: "x".repeat(1501),
    });
    expect(captureContext).toBe(AGENT_ENTITY_CONTEXT);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  }, 20_000);

  test("legacy protocol writes no settings even with a filterPrompt", async () => {
    const { requests, captureContext } = await runClient({
      apiVersion: "legacy",
      filterPrompt: "Focus on build tooling decisions.",
    });
    expect(captureContext).toBe("Focus on build tooling decisions.");
    expect(requests.some(isOrgSettingsWrite)).toBe(false);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    expect(requests.some((request) => request.path === "/v4/search")).toBe(true);
  }, 20_000);
});
