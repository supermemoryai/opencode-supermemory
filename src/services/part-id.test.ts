import { describe, expect, test } from "bun:test";

import { createSyntheticPartId } from "./part-id.js";

describe("createSyntheticPartId", () => {
  test("generates prt-prefixed context ids compatible with current OpenCode schema", () => {
    expect(createSyntheticPartId("context", 1234567890)).toBe("prt_supermemory-context-1234567890");
  });

  test("generates prt-prefixed nudge ids compatible with current OpenCode schema", () => {
    expect(createSyntheticPartId("nudge", 1234567890)).toBe("prt_supermemory-nudge-1234567890");
  });
});
