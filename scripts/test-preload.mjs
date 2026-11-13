import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

// Keep tests away from the developer's Supermemory config and local dedupe state.
const home = mkdtempSync(join(os.tmpdir(), "opencode-supermemory-test-"));
const homedir = () => home;
mock.module("node:os", () => ({ ...os, default: { ...os, homedir }, homedir }));
mock.module("os", () => ({ ...os, default: { ...os, homedir }, homedir }));
