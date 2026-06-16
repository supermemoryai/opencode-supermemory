import { getRecallConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Reasoned recall directive.
//
// Injected before every user turn so the model REASONS about whether recalling
// saved memory would help THIS message, instead of eagerly dumping context at
// session start. The decision is the model's, per message; this module only
// builds the directive text (no network call here).
//
// Edit this text to tune behavior, or override it globally via the
// `recallDirective` setting in ~/.config/opencode/supermemory.jsonc.
// ---------------------------------------------------------------------------
export const DEFAULT_RECALL_DIRECTIVE = `<supermemory-recall>
Before responding, silently decide whether recalling saved memory (past sessions, decisions, conventions, the user's preferences) would materially improve your answer to THIS message. Reason first — don't search reflexively, and don't narrate the decision.

Recall — by calling the \`supermemory\` tool with \`mode: "search"\` — when the message:
- refers to earlier work or decisions ("the auth flow", "like we did", "continue", "the bug from before")
- touches an area where saved conventions, patterns, or preferences likely exist
- is ambiguous in a way past context would resolve

Skip recall when the message is self-contained, trivial, a greeting/meta, fully answerable from the current conversation, or you already recalled the relevant context this session and the topic hasn't shifted.

Cadence is per-message: it's fine to recall on several turns in a row, and fine to never recall in a session. When you do recall, run it before answering and fold the results into your response.
</supermemory-recall>`;

// Appended to the directive only when debug is on. Forces the model to surface
// its recall decision as one visible line, so you can see — per turn — whether
// reasoned recall fired and why. (We can't observe the model's internal
// decision; this makes the model report it.)
const RECALL_DEBUG_SUFFIX = `<recall-debug>
DEBUG MODE: Begin your reply with exactly one line, then continue normally:
[recall-decision] yes|no — <short reason>
"yes" means you are recalling saved Supermemory memory (via the \`supermemory\` tool with \`mode: "search"\`) for THIS message; "no" means you are skipping it.
</recall-debug>`;

/**
 * Build the recall directive shown to the model this turn: the user/project
 * override if set (via `recallDirective`), otherwise the built-in default,
 * plus the debug self-report suffix when SUPERMEMORY_DEBUG is set.
 */
export function buildRecallDirective(): string {
  const { directive } = getRecallConfig();
  let text = directive || DEFAULT_RECALL_DIRECTIVE;
  if (process.env.SUPERMEMORY_DEBUG) {
    text += `\n\n${RECALL_DEBUG_SUFFIX}`;
  }
  return text;
}
