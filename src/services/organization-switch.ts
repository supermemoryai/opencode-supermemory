import type { AuthResult } from "./auth.js";

const SESSION_TIMEOUT_MS = 30_000;

export interface SessionOrganization {
  id: string;
  name?: string;
}

export type OrganizationVerificationResult =
  | { success: true; organization: SessionOrganization }
  | { success: false; error: string };

export type OrganizationSwitchResult =
  | {
      success: true;
      organization: SessionOrganization;
      apiBaseUrl: string;
    }
  | { success: false; error: string };

interface OrganizationSwitchDependencies {
  authorize: () => Promise<AuthResult>;
  save: (apiKey: string, apiBaseUrl?: string) => void;
  defaultApiBaseUrl: string;
  verify?: (
    apiKey: string,
    apiBaseUrl: string,
  ) => Promise<OrganizationVerificationResult>;
}

interface SessionResponse {
  org?: {
    id?: unknown;
    name?: unknown;
  };
}

export async function verifyOrganizationCredential(
  apiKey: string,
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OrganizationVerificationResult> {
  try {
    const response = await fetchImpl(`${apiBaseUrl.replace(/\/+$/, "")}/v3/session`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-sm-source": "opencode",
      },
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `The selected organization could not be verified (HTTP ${response.status}).`,
      };
    }

    const session = (await response.json()) as SessionResponse;
    if (!session.org || typeof session.org.id !== "string" || !session.org.id) {
      return {
        success: false,
        error: "The selected organization was missing from the session response.",
      };
    }

    return {
      success: true,
      organization: {
        id: session.org.id,
        name:
          typeof session.org.name === "string" && session.org.name
            ? session.org.name
            : undefined,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: `The selected organization could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function switchOrganizationCredential(
  dependencies: OrganizationSwitchDependencies,
): Promise<OrganizationSwitchResult> {
  const authorization = await dependencies.authorize();
  if (!authorization.success) return authorization;

  const apiBaseUrl = authorization.apiBaseUrl ?? dependencies.defaultApiBaseUrl;
  const verify = dependencies.verify ?? verifyOrganizationCredential;
  const verification = await verify(authorization.apiKey, apiBaseUrl);
  if (!verification.success) return verification;

  try {
    dependencies.save(authorization.apiKey, authorization.apiBaseUrl);
  } catch (error) {
    return {
      success: false,
      error: `The verified credentials could not be saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    success: true,
    organization: verification.organization,
    apiBaseUrl,
  };
}

export function getCredentialOverrideWarnings(options: {
  environmentApiKey: boolean;
  configApiKeyPath?: string;
}): string[] {
  const warnings: string[] = [];
  if (options.environmentApiKey) {
    warnings.push(
      "SUPERMEMORY_API_KEY is set and takes precedence over the browser credential.",
    );
  }
  if (options.configApiKeyPath) {
    warnings.push(
      `apiKey in ${options.configApiKeyPath} takes precedence over the browser credential.`,
    );
  }
  return warnings;
}
