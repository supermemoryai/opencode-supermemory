import { getRecallConfig } from "../config.js";

export const DEFAULT_RECALL_DIRECTIVE = `<supermemory-recall>
Before responding, silently decide whether recalling saved memory (past sessions, decisions, conventions, the user's preferences) would materially improve your answer to THIS message. Reason first — don't search reflexively, and don't narrate the decision.

Recall — by calling the \`supermemory\` tool with \`mode: "search"\` — when the message:
- refers to earlier work or decisions ("the auth flow", "like we did", "continue", "the bug from before")
- touches an area where saved conventions, patterns, or preferences likely exist
- is ambiguous in a way past context would resolve

Skip recall when the message is self-contained, trivial, a greeting/meta, fully answerable from the current conversation, or you already recalled the relevant context this session and the topic hasn't shifted.

Cadence is per-message: it's fine to recall on several turns in a row, and fine to never recall in a session. When you do recall, run it before answering and fold the results into your response.
</supermemory-recall>`;

const RECALL_DEBUG_SUFFIX = `<recall-debug>
DEBUG MODE: Begin your reply with exactly one line, then continue normally:
[recall-decision] yes|no — <short reason>
"yes" means you are recalling saved Supermemory memory (via the \`supermemory\` tool with \`mode: "search"\`) for THIS message; "no" means you are skipping it.
</recall-debug>`;

export function buildRecallDirective(): string {
  const { directive } = getRecallConfig();
  let text = directive || DEFAULT_RECALL_DIRECTIVE;
  if (process.env.SUPERMEMORY_DEBUG) {
    text += `\n\n${RECALL_DEBUG_SUFFIX}`;
  }
  return text;
}
