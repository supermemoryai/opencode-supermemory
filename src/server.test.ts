import { describe, expect, test } from "bun:test";

import plugin from "./server.js";

describe("server entry", () => {
  // OpenCode V1 and OpenCode 2 both resolve the package's ./server export.
  test("exposes setup() for OpenCode 2 and server() for OpenCode V1", () => {
    expect(plugin.id).toBe("supermemory");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
    // V1 rejects an object that has both server() and tui().
    expect("tui" in plugin).toBe(false);
  });
});
