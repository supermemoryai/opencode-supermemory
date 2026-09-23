export const COMPACTION_CONTEXT_MARKER = "[SUPERMEMORY COMPACTION CONTEXT]";
const MAX_COMPACTION_MEMORY_CHARS = 12_000;
const MAX_SINGLE_MEMORY_CHARS = 2_000;

/**
 * Bounds the project memories injected into a compaction prompt so a large
 * memory store cannot crowd out the transcript being summarized.
 */
export function fitProjectMemories(memories: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let remaining = MAX_COMPACTION_MEMORY_CHARS;

  for (const rawMemory of memories) {
    const normalized = rawMemory.trim();
    if (!normalized || seen.has(normalized) || remaining <= 0) continue;
    seen.add(normalized);

    const memory = normalized.slice(
      0,
      Math.min(MAX_SINGLE_MEMORY_CHARS, remaining),
    );
    result.push(memory);
    remaining -= memory.length;
  }

  return result;
}

export function createCompactionPrompt(projectMemories: string[]): string {
  const memoriesSection =
    projectMemories.length > 0
      ? `
## Project Knowledge (from Supermemory)
The following project-specific knowledge should be preserved and referenced in the summary:
${projectMemories.map((memory) => `- ${memory}`).join("\n")}
`
      : "";

  return `${COMPACTION_CONTEXT_MARKER}

When summarizing this session, you MUST include the following sections in your summary:

## 1. User Requests (As-Is)
- List all original user requests exactly as they were stated
- Preserve the user's exact wording and intent

## 2. Final Goal
- What the user ultimately wanted to achieve
- The end result or deliverable expected

## 3. Work Completed
- What has been done so far
- Files created/modified
- Features implemented
- Problems solved

## 4. Remaining Tasks
- What still needs to be done
- Pending items from the original request
- Follow-up tasks identified during the work

## 5. MUST NOT Do (Critical Constraints)
- Things that were explicitly forbidden
- Approaches that failed and should not be retried
- User's explicit restrictions or preferences
- Anti-patterns identified during the session
${memoriesSection}
This context is critical for maintaining continuity after compaction.
`;
}
