const NETWORK_ERROR_PATTERN =
  /abort|cert|connect|econn|enotfound|fetch failed|network|self.signed|timeout|tls/i;

export function getUserFriendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (NETWORK_ERROR_PATTERN.test(message)) {
    return "Supermemory unreachable (network) — continuing without memory.";
  }
  if (/\b400\b/.test(message)) {
    return "Bad request — your API key or request format may be invalid. Check your key at https://console.supermemory.ai";
  }
  if (/\b401\b/.test(message)) {
    return "Authentication failed — your API key may be expired or revoked. Re-authenticate or check https://console.supermemory.ai";
  }
  if (/\b403\b/.test(message)) {
    return "Permission denied — this feature may require a different Supermemory plan. Check https://supermemory.ai/pricing";
  }
  if (/\b429\b/.test(message)) {
    return "Rate limited — too many requests. Will retry on the next prompt.";
  }
  if (/\b5\d\d\b/.test(message)) {
    return "Supermemory service is temporarily unavailable. Will retry on the next prompt.";
  }

  return message || "Unknown error";
}
