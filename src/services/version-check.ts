const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const CHECK_TIMEOUT_MS = 3000;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateCommand: string;
}

function parseVersion(version: string): { parts: number[]; prerelease: string | null } | null {
  const normalized = version.trim().replace(/^v/i, "");
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;

  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

function isVersionNewer(latestVersion: string, currentVersion: string): boolean {
  const latest = parseVersion(latestVersion);
  const current = parseVersion(currentVersion);
  if (!latest || !current) return latestVersion !== currentVersion;

  for (let i = 0; i < 3; i++) {
    const latestPart = latest.parts[i] ?? 0;
    const currentPart = current.parts[i] ?? 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }

  if (!latest.prerelease && current.prerelease) return true;
  if (latest.prerelease && !current.prerelease) return false;
  return latest.prerelease !== current.prerelease && latest.prerelease !== null;
}

export async function checkNpmUpdate(
  packageName: string,
  currentVersion: string,
  updateCommand: string,
): Promise<UpdateInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const encodedPackage = packageName.startsWith("@")
      ? packageName.replace("/", "%2F")
      : encodeURIComponent(packageName);
    const response = await fetch(`${NPM_REGISTRY_URL}/${encodedPackage}/latest`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const data = (await response.json()) as { version?: unknown };
    const latestVersion = typeof data.version === "string" ? data.version : null;
    if (!latestVersion || !isVersionNewer(latestVersion, currentVersion)) return null;

    return { currentVersion, latestVersion, updateCommand };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function formatUpdateNotice(info: UpdateInfo): string {
  return [
    "[SUPERMEMORY UPDATE]",
    `Supermemory update available: v${info.currentVersion} -> v${info.latestVersion}`,
    `Run (if you have a JS runtime): ${info.updateCommand}`,
    `Otherwise (e.g. standalone opencode binary), pin "opencode-supermemory@${info.latestVersion}" in your opencode config and restart.`,
  ].join("\n");
}
