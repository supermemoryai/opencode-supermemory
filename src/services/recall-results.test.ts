import { describe, expect, test } from "bun:test";

import {
  formatRecallHit,
  normalizeRecallResults,
} from "./recall-results.js";

describe("recall result normalization", () => {
  test("keeps the strongest supported result shapes with provenance", () => {
    const hits = normalizeRecallResults([
      { memory: "memory result", similarity: 0.99 },
      { chunk: "chunk result", similarity: 0.9 },
      { content: "content result", similarity: 0.8 },
      { text: "text result", similarity: 0.7 },
      {
        context: "context result",
        similarity: 0.6,
        title: "Decision",
        filepath: "src/index.ts",
      },
      { memory: "below threshold", similarity: 0.54 },
      { memory: "sixth result", similarity: 0.56 },
    ]);

    expect(hits.map((hit) => hit.text)).toEqual([
      "memory result",
      "chunk result",
      "content result",
      "text result",
      "context result",
    ]);
    expect(formatRecallHit(hits[4]!)).toBe(
      "Decision: context result (src/index.ts)",
    );

    const unscored = normalizeRecallResults([
      { memory: "missing score remains valid" },
      { memory: "non-finite score remains valid", similarity: Number.NaN },
    ]);
    expect(unscored.map((hit) => hit.text)).toEqual([
      "missing score remains valid",
      "non-finite score remains valid",
    ]);

    const titleAlreadyPresent = normalizeRecallResults([
      {
        title: "Migration plan",
        content: "Migration plan: use expand-contract migrations",
        similarity: 0.9,
      },
    ])[0]!;
    expect(formatRecallHit(titleAlreadyPresent)).toBe(
      "Migration plan: use expand-contract migrations",
    );
  });
});
