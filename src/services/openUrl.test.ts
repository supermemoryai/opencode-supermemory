import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openUrl } from "./openUrl.js";

const URL_WITH_SPECIALS = "https://example.com/a?x=1&y=a%20b&q='it'&z=%26";
const saved = {
  PATH: process.env.PATH,
  WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME,
  WSL_INTEROP: process.env.WSL_INTEROP,
};
let bin: string;

function stub(...names: string[]): void {
  for (const name of names) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "${file}.args"\n`);
    chmodSync(file, 0o755);
  }
}

function opened(name: string): string[] | undefined {
  const file = join(bin, `${name}.args`);
  return existsSync(file) ? readFileSync(file, "utf-8").trimEnd().split("\n") : undefined;
}

describe.skipIf(process.platform !== "linux")("openUrl on Linux", () => {
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "open-url-"));
    process.env.PATH = bin;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("prefers wslview on WSL", async () => {
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    stub("wslview", "powershell.exe", "xdg-open");
    await openUrl(URL_WITH_SPECIALS);
    expect(opened("wslview")).toEqual([URL_WITH_SPECIALS]);
    expect(opened("powershell.exe")).toBeUndefined();
    expect(opened("xdg-open")).toBeUndefined();
  });

  test("passes the URL intact to PowerShell on WSL without wslview", async () => {
    process.env.WSL_INTEROP = "/run/WSL/1_interop";
    stub("powershell.exe", "xdg-open");
    await openUrl(URL_WITH_SPECIALS);
    const encoded = opened("powershell.exe")!.at(-1)!;
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(
      `Start-Process '${URL_WITH_SPECIALS.replaceAll("'", "''")}'`,
    );
    expect(opened("xdg-open")).toBeUndefined();
  });

  test("falls back to xdg-open on WSL without Windows openers", async () => {
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    stub("xdg-open");
    await openUrl(URL_WITH_SPECIALS);
    expect(opened("xdg-open")).toEqual([URL_WITH_SPECIALS]);
  });

  test.skipIf(/microsoft/i.test(readFileSync("/proc/version", "utf-8")))(
    "ignores WSL openers outside WSL",
    async () => {
      stub("wslview", "xdg-open");
      await openUrl(URL_WITH_SPECIALS);
      expect(opened("xdg-open")).toEqual([URL_WITH_SPECIALS]);
      expect(opened("wslview")).toBeUndefined();
    },
  );
});
