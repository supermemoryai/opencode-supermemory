import { describe, expect, test } from "bun:test";

import { AGENT_ENTITY_CONTEXT } from "./entity-context.js";

describe("capture entity context", () => {
  test("prioritizes human-memorable knowledge over transient Git state", () => {
    expect(AGENT_ENTITY_CONTEXT).toContain("human teammate");
    expect(AGENT_ENTITY_CONTEXT).toContain("decisions, lessons, preferences");
    expect(AGENT_ENTITY_CONTEXT).toContain("Transient repository state Git already tracks");
  });
});
