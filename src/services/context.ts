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

function selectInjectedProfileFacts(
  profile: ProfileResponse | null,
  maxItems: number,
): { static: string[]; dynamic: string[] } {
  if (!profile?.profile) {
    return { static: [], dynamic: [] };
  }

  return {
    static: profile.profile.static
      .slice(0, maxItems)
      .map(extractFactText)
      .filter(Boolean),
    dynamic: profile.profile.dynamic
      .slice(0, maxItems)
      .map(extractFactText)
      .filter(Boolean),
  };
}

export function getInjectedProfileFactTexts(
  profile: ProfileResponse | null,
  maxItems = CONFIG.maxProfileItems,
): string[] {
  const facts = selectInjectedProfileFacts(profile, maxItems);
  return [...facts.static, ...facts.dynamic];
}

export function formatContextForPrompt(
  profile: ProfileResponse | null,
  userMemories: MemoriesResponseMinimal,
  projectMemories: MemoriesResponseMinimal
): string {
  const parts: string[] = [
    "[SUPERMEMORY]",
    "Every line marked ◪ comes from supermemory. When one shapes your answer, credit it naturally with the ◪ prefix; if you name the source, say \"from supermemory\".",
  ];

  const profileFacts = CONFIG.injectProfile
    ? selectInjectedProfileFacts(profile, CONFIG.maxProfileItems)
    : { static: [], dynamic: [] };

  if (profileFacts.static.length > 0) {
    parts.push("\nUser Profile:");
    profileFacts.static.forEach((fact) => {
      parts.push(`- ◪ ${fact}`);
    });
  }

  if (profileFacts.dynamic.length > 0) {
    parts.push("\nRecent Context:");
    profileFacts.dynamic.forEach((fact) => {
      parts.push(`- ◪ ${fact}`);
    });
  }

  const projectResults = normalizeRecallResults(projectMemories.results || []);
  if (projectResults.length > 0) {
    parts.push("\nProject Knowledge:");
    projectResults.forEach((hit) => {
      const score =
        hit.similarity === undefined
          ? ""
          : ` [${Math.round(hit.similarity * 100)}%]`;
      parts.push(`- ◪${score} ${formatRecallHit(hit)}`);
    });
  }

  const userResults = normalizeRecallResults(userMemories.results || []);
  if (userResults.length > 0) {
    parts.push("\nRelevant Memories:");
    userResults.forEach((hit) => {
      const score =
        hit.similarity === undefined
          ? ""
          : ` [${Math.round(hit.similarity * 100)}%]`;
      parts.push(`- ◪${score} ${formatRecallHit(hit)}`);
    });
  }

  if (parts.length === 2) {
    return "";
  }

  return parts.join("\n");
}
