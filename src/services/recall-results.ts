import type { SearchResultItem } from "./client.js";

export const MIN_RECALL_SIMILARITY = 0.55;
export const MAX_RECALL_RESULTS = 5;
export const MAX_RECALL_HIT_CHARS = 300;

export interface RecallHit {
  result: SearchResultItem;
  text: string;
  similarity: number;
  title?: string;
  filepath?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function getRecallResultText(result: SearchResultItem): string {
  return (
    nonEmptyString(result.memory) ??
    nonEmptyString(result.chunk) ??
    nonEmptyString(result.content) ??
    nonEmptyString(result.text) ??
    nonEmptyString(result.context) ??
    ""
  );
}

function getRecallResultTitle(result: SearchResultItem): string | undefined {
  return nonEmptyString(result.title) ?? nonEmptyString(result.metadata?.title);
}

function getRecallResultFilepath(result: SearchResultItem): string | undefined {
  return (
    nonEmptyString(result.filepath) ??
    nonEmptyString(result.metadata?.filepath) ??
    nonEmptyString(result.metadata?.filePath) ??
    nonEmptyString(result.metadata?.path)
  );
}

function truncateHit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

export function normalizeRecallResult(
  result: SearchResultItem,
  maxHitChars?: number,
): RecallHit | null {
  const text = getRecallResultText(result);
  if (!text) return null;

  return {
    result,
    text:
      maxHitChars === undefined
        ? text
        : truncateHit(text, Math.max(1, maxHitChars)),
    similarity: result.similarity ?? result.score ?? 0,
    title: getRecallResultTitle(result),
    filepath: getRecallResultFilepath(result),
  };
}

export function normalizeRecallResults(
  results: SearchResultItem[],
  options?: {
    limit?: number;
    minSimilarity?: number;
    maxHitChars?: number;
  },
): RecallHit[] {
  const limit = Math.max(0, options?.limit ?? MAX_RECALL_RESULTS);
  const minSimilarity = Math.max(
    MIN_RECALL_SIMILARITY,
    options?.minSimilarity ?? MIN_RECALL_SIMILARITY,
  );
  const maxHitChars = Math.max(1, options?.maxHitChars ?? MAX_RECALL_HIT_CHARS);
  const seen = new Set<string>();

  return results
    .map((result) => normalizeRecallResult(result, maxHitChars))
    .filter((hit): hit is RecallHit => hit !== null)
    .filter((hit) => hit.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .filter((hit) => {
      const key = hit.text.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export function formatRecallHit(hit: RecallHit): string {
  const title = hit.title ? `${hit.title}: ` : "";
  const filepath = hit.filepath ? ` (${hit.filepath})` : "";
  return `${title}${hit.text}${filepath}`;
}
