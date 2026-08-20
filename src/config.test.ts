import { describe, expect, test } from "bun:test";

import {
  resolveCompactionEnabled,
  validateCompactionThreshold,
} from "./config.js";

describe("compaction configuration", () => {
  test("treats zero and false as legacy disable values", () => {
    expect(validateCompactionThreshold(0)).toBe(0);
    expect(validateCompactionThreshold(false)).toBe(0);
    expect(resolveCompactionEnabled(undefined, 0)).toBe(false);
    expect(resolveCompactionEnabled(undefined, false)).toBe(false);
  });

  test("prefers the explicit compactionEnabled setting", () => {
    expect(resolveCompactionEnabled(false, 0.8)).toBe(false);
    expect(resolveCompactionEnabled(true, 0)).toBe(true);
  });

  test("falls back safely for invalid legacy thresholds", () => {
    expect(validateCompactionThreshold(-1)).toBe(0.8);
    expect(validateCompactionThreshold(2)).toBe(0.8);
    expect(validateCompactionThreshold(Number.NaN)).toBe(0.8);
    expect(resolveCompactionEnabled(undefined, undefined)).toBe(true);
  });
});
