import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureSession, readCursor, type SessionWriter } from "./session.js";

type Sent = { raw: string; offset: number; generation: number };

function message(id: string, text: string) {
  return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}

function recordingWriter(sent: Sent[], fail = false): SessionWriter {
  return {
    async addSession(_namespace, raw, options) {
      if (fail) throw new Error("network down");
      sent.push({ raw, offset: options.offset, generation: options.generation });
    },
  };
}

function capture(sessionId: string, messages: unknown[], writer: SessionWriter) {
  return captureSession({
    writer,
    namespace: "ns_test",
    sessionId,
    messages,
    logger: () => undefined,
  });
}

beforeEach(() => {
  process.env.SUPERMEMORY_SESSION_DIR = mkdtempSync(join(tmpdir(), "sm-session-"));
});

test("sends only the messages added since the last accepted send", async () => {
  const sent: Sent[] = [];
  const writer = recordingWriter(sent);
  const first = [message("m1", "one"), message("m2", "two")];
  expect(await capture("s1", first, writer)).toBe(true);
  expect(await capture("s1", [...first, message("m3", "three")], writer)).toBe(true);

  expect(sent.map((s) => s.offset)).toEqual([0, 2]);
  expect(sent[1]?.raw).toContain("three");
  expect(sent[1]?.raw).not.toContain("one");
  expect(readCursor("s1", "ns_test").count).toBe(3);
});

test("a failed send keeps the cursor so the next capture resends it", async () => {
  const messages = [message("m1", "one"), message("m2", "two")];
  expect(await capture("s2", messages, recordingWriter([], true))).toBe(false);
  expect(readCursor("s2", "ns_test").count).toBe(0);

  const sent: Sent[] = [];
  expect(await capture("s2", messages, recordingWriter(sent))).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.offset).toBe(0);
  expect(sent[0]?.raw).toContain("one");
  expect(readCursor("s2", "ns_test").count).toBe(2);
});

test("the cursor moves only after the server accepts the send", async () => {
  let accept!: () => void;
  const writer: SessionWriter = {
    addSession: () => new Promise<void>((resolve) => (accept = resolve)),
  };
  const pending = capture("s3", [message("m1", "one")], writer);
  await Bun.sleep(10);
  expect(readCursor("s3", "ns_test").count).toBe(0);

  accept();
  expect(await pending).toBe(true);
  expect(readCursor("s3", "ns_test").count).toBe(1);
});

test("a cursor accepted by one destination does not suppress another", async () => {
  const messages = [message("m1", "one")];
  const sent: Sent[] = [];
  expect(await capture("s4", messages, recordingWriter(sent))).toBe(true);
  expect(await capture("s4", messages, recordingWriter(sent))).toBe(true);
  expect(sent).toHaveLength(1);

  const previous = process.env.SUPERMEMORY_API_URL;
  process.env.SUPERMEMORY_API_URL = "https://other.example.com";
  try {
    expect(await capture("s4", messages, recordingWriter(sent))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.SUPERMEMORY_API_URL;
    else process.env.SUPERMEMORY_API_URL = previous;
  }
  expect(sent).toHaveLength(2);
  expect(sent[1]?.offset).toBe(0);
});

test("private blocks are stripped and fully private turns never leave the machine", async () => {
  const sent: Sent[] = [];
  const messages = [
    message("m1", "use <private>sk-secret</private> here"),
    message("m2", "<private>only secret</private>"),
    { info: { id: "m3", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "echo only secret" }] },
    message("m4", "public"),
  ];
  expect(await capture("s5", messages, recordingWriter(sent))).toBe(true);
  expect(sent[0]?.raw).toContain("[REDACTED]");
  expect(sent[0]?.raw).not.toContain("sk-secret");
  expect(sent[0]?.raw).not.toContain("only secret");
  expect(sent[0]?.raw).toContain("public");
  expect(readCursor("s5", "ns_test").count).toBe(2);
});

test("process.exit waits for an in-flight capture to finish", () => {
  const sessionModule = join(import.meta.dir, "session.ts");
  const script = `
    const { holdExitUntilSettled } = await import(${JSON.stringify(sessionModule)});
    holdExitUntilSettled(new Promise((resolve) => setTimeout(() => { console.log("capture finished"); resolve(); }, 200)));
    process.exit(3);
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "sm-home-")) },
  });

  expect(result.stdout.toString()).toContain("capture finished");
  expect(result.exitCode).toBe(3);
});
