import { describe, expect, test } from "bun:test";

import {
  activityLabel,
  getRecallActivity,
  recallLabel,
  STATUS_PREFIX,
  statusText,
} from "./tui-status.js";

describe("status footer helpers", () => {
  test("reads recall activity from metadata or recalled context text", () => {
    expect(
      getRecallActivity({
        type: "text",
        text: "",
        metadata: { supermemory: { activity: "recalled", count: 2, tokens: 90 } },
      }),
    ).toEqual({ count: 2, tokens: 90 });

    const text = ["<supermemory-context>", "- ◪ one", "- ◪ two", "- ◪ three", "</supermemory-context>"].join("\n");
    expect(getRecallActivity({ type: "text", text })).toEqual({
      count: 3,
      tokens: Math.round(text.length / 4),
    });
    expect(getRecallActivity({ type: "tool", text })).toBeNull();
    expect(getRecallActivity({ type: "text", text: "plain" })).toBeNull();
  });

  test("formats footer text", () => {
    expect(recallLabel({ count: 1, tokens: 40 })).toBe("recalled 1 memory (40 tok)");
    expect(activityLabel(`${STATUS_PREFIX}saved this turn`)).toBe("saved this turn");
    expect(activityLabel("other")).toBe("other");
    expect(statusText(true, "saved this turn")).toBe(`${STATUS_PREFIX}running`);
    expect(statusText(false, "saved this turn")).toBe(`${STATUS_PREFIX}saved this turn`);
    expect(statusText(false, "")).toBe("◪ supermemory");
  });
});
