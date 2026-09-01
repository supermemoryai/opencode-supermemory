import { describe, expect, test } from "bun:test";

import { createToolMemoryMetadata } from "../index.js";
import { createCompactionMemoryMetadata } from "./compaction.js";

const tags = {
  projectName: "test-project",
  projectId: "0123456789abcdef",
};

describe("memory write metadata", () => {
  test("builds the tool write payload with agent_scope only", () => {
    const metadata = createToolMemoryMetadata("project", "preference", tags);

    expect(metadata).toEqual({
      type: "preference",
      project: "test-project",
      sm_project_id: "0123456789abcdef",
      agent_scope: "project",
      sm_capture_mode: "tool",
    });
    expect(metadata).not.toHaveProperty("sm_scope");
  });

  test("builds the compaction write payload with agent_scope only", () => {
    const metadata = createCompactionMemoryMetadata(tags, "session-1");

    expect(metadata).toEqual({
      type: "conversation",
      project: "test-project",
      sm_project_id: "0123456789abcdef",
      agent_scope: "personal",
      sm_capture_mode: "compaction",
      sessionId: "session-1",
    });
    expect(metadata).not.toHaveProperty("sm_scope");
  });
});
