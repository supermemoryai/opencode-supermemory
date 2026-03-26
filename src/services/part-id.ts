export function createSyntheticPartId(kind: "context" | "nudge", now = Date.now()): string {
  return `prt_supermemory-${kind}-${now}`;
}
