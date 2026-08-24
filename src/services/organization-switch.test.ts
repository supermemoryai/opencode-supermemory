import { describe, expect, test } from "bun:test";
import {
  getCredentialOverrideWarnings,
  switchOrganizationCredential,
  verifyOrganizationCredential,
} from "./organization-switch.js";

describe("organization switching", () => {
  test("verifies and reports the organization from the selected key", async () => {
    const result = await verifyOrganizationCredential(
      "sm_org-1_secret",
      "https://api.supermemory.ai/",
      (async (url, init) => {
        expect(url).toBe("https://api.supermemory.ai/v3/session");
        expect(init?.headers).toEqual({
          Authorization: "Bearer sm_org-1_secret",
          "x-sm-source": "opencode",
        });
        return new Response(
          JSON.stringify({ org: { id: "org-1", name: "Engineering" } }),
          { status: 200 },
        );
      }) as typeof fetch,
    );

    expect(result).toEqual({
      success: true,
      organization: { id: "org-1", name: "Engineering" },
    });
  });

  test("does not replace credentials when authorization is cancelled", async () => {
    let saved = false;
    const result = await switchOrganizationCredential({
      authorize: async () => ({ success: false, error: "Cancelled" }),
      save: () => {
        saved = true;
      },
      defaultApiBaseUrl: "https://api.supermemory.ai",
    });

    expect(result).toEqual({ success: false, error: "Cancelled" });
    expect(saved).toBe(false);
  });

  test("does not replace credentials when the selected key cannot be verified", async () => {
    let saved = false;
    const result = await switchOrganizationCredential({
      authorize: async () => ({ success: true, apiKey: "sm_org-1_secret" }),
      save: () => {
        saved = true;
      },
      defaultApiBaseUrl: "https://api.supermemory.ai",
      verify: async () => ({ success: false, error: "Unauthorized" }),
    });

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(saved).toBe(false);
  });

  test("rejects a successful session response without an organization", async () => {
    const result = await verifyOrganizationCredential(
      "sm_unknown_secret",
      "https://api.supermemory.ai",
      (async () =>
        new Response(JSON.stringify({ user: { id: "user-1" } }), {
          status: 200,
        })) as unknown as typeof fetch,
    );

    expect(result).toEqual({
      success: false,
      error: "The selected organization was missing from the session response.",
    });
  });

  test("saves only after verification succeeds", async () => {
    let savedKey: string | undefined;
    let savedApiBaseUrl: string | undefined;
    const result = await switchOrganizationCredential({
      authorize: async () => ({
        success: true,
        apiKey: "sm_org-2_secret",
        apiBaseUrl: "https://custom.example.test",
      }),
      save: (apiKey, apiBaseUrl) => {
        savedKey = apiKey;
        savedApiBaseUrl = apiBaseUrl;
      },
      defaultApiBaseUrl: "https://api.supermemory.ai",
      verify: async () => ({
        success: true,
        organization: { id: "org-2", name: "Research" },
      }),
    });

    expect(result).toEqual({
      success: true,
      organization: { id: "org-2", name: "Research" },
      apiBaseUrl: "https://custom.example.test",
    });
    expect(savedKey).toBe("sm_org-2_secret");
    expect(savedApiBaseUrl).toBe("https://custom.example.test");
  });

  test("warns about every browser credential override", () => {
    expect(
      getCredentialOverrideWarnings({
        environmentApiKey: true,
        configApiKeyPath: "/home/user/.config/opencode/supermemory.jsonc",
      }),
    ).toEqual([
      "SUPERMEMORY_API_KEY is set and takes precedence over the browser credential.",
      "apiKey in /home/user/.config/opencode/supermemory.jsonc takes precedence over the browser credential.",
    ]);
  });
});
