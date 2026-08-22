import type { ProfileResponse, SearchResultItem } from "./client.js";
import { CONFIG } from "../config.js";
import {
  formatRecallHit,
  normalizeRecallResults,
} from "./recall-results.js";

interface MemoriesResponseMinimal {
  results?: SearchResultItem[];
}

function extractFactText(fact: unknown): string {
  if (typeof fact === "string") return fact;
  if (fact != null && typeof fact === "object") {
    const content = (fact as { content?: string }).content;
    if (typeof content === "string") return content;
    return JSON.stringify(fact);
  }
  return String(fact ?? "");
}

export function formatContextForPrompt(
  profile: ProfileResponse | null,
  userMemories: MemoriesResponseMinimal,
  projectMemories: MemoriesResponseMinimal
): string {
  const parts: string[] = ["[SUPERMEMORY]"];

  if (CONFIG.injectProfile && profile?.profile) {
    const { static: staticFacts, dynamic: dynamicFacts } = profile.profile;

    if (staticFacts.length > 0) {
      parts.push("\nUser Profile:");
      staticFacts.slice(0, CONFIG.maxProfileItems).forEach((fact) => {
        const text = extractFactText(fact);
        parts.push(`- ${text}`);
      });
    }

    if (dynamicFacts.length > 0) {
      parts.push("\nRecent Context:");
      dynamicFacts.slice(0, CONFIG.maxProfileItems).forEach((fact) => {
        const text = extractFactText(fact);
        parts.push(`- ${text}`);
      });
    }
  }

  const projectResults = normalizeRecallResults(projectMemories.results || []);
  if (projectResults.length > 0) {
    parts.push("\nProject Knowledge:");
    projectResults.forEach((hit) => {
      const similarity = Math.round(hit.similarity * 100);
      parts.push(`- [${similarity}%] ${formatRecallHit(hit)}`);
    });
  }

  const userResults = normalizeRecallResults(userMemories.results || []);
  if (userResults.length > 0) {
    parts.push("\nRelevant Memories:");
    userResults.forEach((hit) => {
      const similarity = Math.round(hit.similarity * 100);
      parts.push(`- [${similarity}%] ${formatRecallHit(hit)}`);
    });
  }

  if (parts.length === 1) {
    return "";
  }

  return parts.join("\n");
}
