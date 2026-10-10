/**
 * OpenCode 2 permission rule that lets the read-only `supermemory_recall` tool
 * run without prompting. Kept dependency-free so the server plugin bundle does
 * not pull in the JSONC editor used by the installer.
 */
export const RECALL_PERMISSION = {
  action: "supermemory_recall",
  resource: "*",
  effect: "allow",
} as const;
