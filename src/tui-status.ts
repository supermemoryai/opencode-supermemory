/**
 * Pure helpers for the persistent `◪ supermemory` footer shared by the OpenCode
 * V1 and OpenCode 2 TUI plugins. Kept free of JSX so they can be unit tested.
 */
export const STATUS_PREFIX = "◪ supermemory · ";
export const DEFAULT_STATUS_ACTIVITY = "ready";

export interface RecallActivity {
  count: number;
  tokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads recall activity from an OpenCode V1 message part: either the metadata
 * the server plugin attaches to direct-recall parts, or the recalled context
 * text itself for older plugin builds.
 */
export function getRecallActivity(part: unknown): RecallActivity | null {
  const value = asRecord(part);
  if (!value || value.type !== "text") return null;

  const metadata = asRecord(value.metadata);
  const supermemory = asRecord(metadata?.supermemory);
  if (supermemory?.activity === "recalled") {
    const count = supermemory.count;
    const tokens = supermemory.tokens;
    if (typeof count === "number" && typeof tokens === "number") {
      return { count, tokens };
    }
  }

  const text = typeof value.text === "string" ? value.text : "";
  if (!text.includes("<supermemory-context>")) return null;
  const count = text.split("\n").filter((line) => line.startsWith("- ◪ ")).length;
  return count > 0 ? { count, tokens: Math.round(text.length / 4) } : null;
}

export function recallLabel(activity: RecallActivity): string {
  return `recalled ${activity.count} ${activity.count === 1 ? "memory" : "memories"} (${activity.tokens} tok)`;
}

/** Strips the shared notice prefix so the footer shows only the activity. */
export function activityLabel(message: string): string {
  return message.startsWith(STATUS_PREFIX)
    ? message.slice(STATUS_PREFIX.length)
    : message;
}

export function statusText(running: boolean, activity: string): string {
  return `${STATUS_PREFIX}${running ? "running" : activity}`;
}
