#!/usr/bin/env node
import { createInterface } from "node:readline";
import { getApiKeyValue } from "./config.js";

const MCP_URL =
  process.env.SUPERMEMORY_MCP_URL || "https://mcp.supermemory.ai/mcp";
const REQUEST_TIMEOUT_MS = 30_000;

let sessionId: string | null = null;

interface JsonRpcMessage {
  id?: string | number | null;
  [key: string]: unknown;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function emitSseData(body: string): void {
  for (const event of body.split("\n\n")) {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data) process.stdout.write(`${data}\n`);
    }
  }
}

async function forward(message: JsonRpcMessage, apiKey: string): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const nextSessionId = response.headers.get("mcp-session-id");
  if (nextSessionId) sessionId = nextSessionId;

  if (response.status === 202) return;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    sendError(
      message.id,
      -32000,
      `Supermemory MCP ${response.status}: ${body.slice(0, 200) || "request failed"}`,
    );
    return;
  }

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  if (!body.trim()) return;

  if (contentType.includes("text/event-stream")) emitSseData(body);
  else process.stdout.write(`${body.trim()}\n`);
}

function main(): void {
  const apiKey = getApiKeyValue();
  let queue = Promise.resolve();
  const lines = createInterface({ input: process.stdin });

  lines.on("line", (line) => {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    queue = queue.then(async () => {
      if (!apiKey) {
        sendError(
          message.id,
          -32001,
          "Supermemory is not authenticated. Run `bunx opencode-supermemory@latest login`, restart OpenCode, or set SUPERMEMORY_API_KEY.",
        );
        return;
      }

      try {
        await forward(message, apiKey);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sendError(message.id, -32000, `Supermemory MCP proxy error: ${detail}`);
      }
    });
  });

  lines.on("close", () => {
    queue.finally(() => process.exit(0));
  });
}

main();
