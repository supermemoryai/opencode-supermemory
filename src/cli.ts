#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { stripJsoncComments } from "./services/jsonc.js";
import { startAuthFlow, clearCredentials, loadCredentials, CREDENTIALS_FILE } from "./services/auth.js";
import { CONFIG, CONFIG_FILE, SUPERMEMORY_API_KEY, getApiBaseUrl, isConfigured, writeInstallDefaults } from "./config.js";
import { getTags } from "./services/tags.js";

const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");
const OPENCODE_COMMAND_DIR = join(OPENCODE_CONFIG_DIR, "command");
const OPENCODE_TUI_CONFIG = join(OPENCODE_CONFIG_DIR, "tui.jsonc");
const OH_MY_OPENCODE_CONFIG = join(OPENCODE_CONFIG_DIR, "oh-my-opencode.json");
const PLUGIN_NAME = "opencode-supermemory@latest";
const DEFAULT_CONFIG_FILE = CONFIG_FILE ?? join(OPENCODE_CONFIG_DIR, "supermemory.json");

const SUPERMEMORY_LOGIN_COMMAND = `---
description: Connect OpenCode to Supermemory
---

# Supermemory Login

Run the browser authentication flow:

\`\`\`bash
bunx opencode-supermemory@latest login
\`\`\`

Wait for authentication to finish, then tell the user to restart OpenCode so the plugin and hosted MCP connection load the new credentials.

If the command says the user is already authenticated, run \`bunx opencode-supermemory@latest status\` and report the result instead of clearing credentials automatically.

Never print the full API key.
Never recommend disabling TLS verification.
`;

const SUPERMEMORY_STATUS_COMMAND = `---
description: Show Supermemory connection status
---

# Supermemory Status

Run this command to check whether OpenCode is connected to Supermemory:

\`\`\`bash
bunx opencode-supermemory@latest status
\`\`\`

Then call the \`supermemory_whoAmI\` MCP tool.

Report API reachability and MCP reachability separately. If \`whoAmI\` is unavailable, say that the MCP tool is unavailable in this OpenCode session and recommend restarting OpenCode. Do not describe that as an API failure.

Never print the full API key.
Never recommend disabling TLS verification.
`;

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function confirm(rl: readline.Interface, question: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(`${question} (y/n) `, (answer) => {
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

function findOpencodeConfig(): string | null {
  const candidates = [
    join(OPENCODE_CONFIG_DIR, "opencode.jsonc"),
    join(OPENCODE_CONFIG_DIR, "opencode.json"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function isSupermemoryPluginSpecifier(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^opencode-supermemory(?:@|$)/.test(value)) return true;
  if (!value.startsWith("file://")) return false;

  try {
    const pluginPath = fileURLToPath(value);
    const candidates = [
      join(pluginPath, "package.json"),
      join(pluginPath, "..", "package.json"),
      join(pluginPath, "..", "..", "package.json"),
    ];
    return candidates.some((packagePath) => {
      if (!existsSync(packagePath)) return false;
      const packageJson = JSON.parse(readFileSync(packagePath, "utf-8")) as {
        name?: unknown;
      };
      return packageJson.name === "opencode-supermemory";
    });
  } catch {
    return false;
  }
}

function addPluginToConfig(configPath: string): boolean {
  try {
    const content = readFileSync(configPath, "utf-8");

    const jsonContent = stripJsoncComments(content);
    let config: Record<string, unknown>;
    
    try {
      config = JSON.parse(jsonContent);
    } catch {
      console.error("✗ Failed to parse config file");
      return false;
    }

    const plugins = Array.isArray(config.plugin) ? config.plugin : [];
    if (plugins.some(isSupermemoryPluginSpecifier)) {
      console.log("✓ Plugin already registered in config");
      return true;
    }
    plugins.push(PLUGIN_NAME);
    config.plugin = plugins;

    if (configPath.endsWith(".jsonc")) {
      if (content.includes('"plugin"')) {
        const newContent = content.replace(
          /("plugin"\s*:\s*\[)([^\]]*?)(\])/,
          (_match, start, middle, end) => {
            const trimmed = middle.trim();
            if (trimmed === "") {
              return `${start}\n    "${PLUGIN_NAME}"\n  ${end}`;
            }
            return `${start}${middle.trimEnd()},\n    "${PLUGIN_NAME}"\n  ${end}`;
          }
        );
        writeFileSync(configPath, newContent);
      } else {
        const newContent = content.replace(
          /^(\s*\{)/,
          `$1\n  "plugin": ["${PLUGIN_NAME}"],`
        );
        writeFileSync(configPath, newContent);
      }
    } else {
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    console.log(`✓ Added plugin to ${configPath}`);
    return true;
  } catch (err) {
    console.error("✗ Failed to update config:", err);
    return false;
  }
}

function createNewConfig(): boolean {
  const configPath = join(OPENCODE_CONFIG_DIR, "opencode.jsonc");
  mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  
  const config = `{
  "plugin": ["${PLUGIN_NAME}"]
}
`;
  
  writeFileSync(configPath, config);
  console.log(`✓ Created ${configPath}`);
  return true;
}

function configureTuiPlugin(): boolean {
  const candidates = [
    join(OPENCODE_CONFIG_DIR, "tui.jsonc"),
    join(OPENCODE_CONFIG_DIR, "tui.json"),
  ];
  const existing = candidates.find((path) => existsSync(path));
  if (existing) return addPluginToConfig(existing);

  mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  writeFileSync(
    OPENCODE_TUI_CONFIG,
    `{
  "plugin": ["${PLUGIN_NAME}"]
}
`,
  );
  console.log(`✓ Enabled persistent Supermemory footer in ${OPENCODE_TUI_CONFIG}`);
  return true;
}

function configureCommands(): boolean {
  mkdirSync(OPENCODE_COMMAND_DIR, { recursive: true });

  for (const name of [
    "supermemory-init.md",
    "supermemory-logout.md",
    "supermemory-switch-organization.md",
  ]) {
    rmSync(join(OPENCODE_COMMAND_DIR, name), { force: true });
  }
  console.log("✓ Removed legacy Supermemory commands");

  const loginPath = join(OPENCODE_COMMAND_DIR, "supermemory-login.md");
  writeFileSync(loginPath, SUPERMEMORY_LOGIN_COMMAND);
  console.log(`✓ Created /supermemory-login command`);

  const statusPath = join(OPENCODE_COMMAND_DIR, "supermemory-status.md");
  writeFileSync(statusPath, SUPERMEMORY_STATUS_COMMAND);
  console.log(`✓ Created /supermemory-status command`);

  return true;
}

function isOhMyOpencodeInstalled(): boolean {
  const configPath = findOpencodeConfig();
  if (!configPath) return false;
  
  try {
    const content = readFileSync(configPath, "utf-8");
    return content.includes("oh-my-opencode");
  } catch {
    return false;
  }
}

function isAutoCompactAlreadyDisabled(): boolean {
  if (!existsSync(OH_MY_OPENCODE_CONFIG)) return false;
  
  try {
    const content = readFileSync(OH_MY_OPENCODE_CONFIG, "utf-8");
    const config = JSON.parse(content);
    const disabledHooks = config.disabled_hooks as string[] | undefined;
    return disabledHooks?.includes("anthropic-context-window-limit-recovery") ?? false;
  } catch {
    return false;
  }
}

function disableAutoCompactHook(): boolean {
  try {
    let config: Record<string, unknown> = {};
    
    if (existsSync(OH_MY_OPENCODE_CONFIG)) {
      const content = readFileSync(OH_MY_OPENCODE_CONFIG, "utf-8");
      config = JSON.parse(content);
    }
    
    const disabledHooks = (config.disabled_hooks as string[]) || [];
    if (!disabledHooks.includes("anthropic-context-window-limit-recovery")) {
      disabledHooks.push("anthropic-context-window-limit-recovery");
    }
    config.disabled_hooks = disabledHooks;
    
    writeFileSync(OH_MY_OPENCODE_CONFIG, JSON.stringify(config, null, 2));
    console.log(`✓ Disabled anthropic-context-window-limit-recovery hook in oh-my-opencode.json`);
    return true;
  } catch (err) {
    console.error("✗ Failed to update oh-my-opencode.json:", err);
    return false;
  }
}

interface InstallOptions {
  tui: boolean;
  disableAutoCompact: boolean;
}

async function install(options: InstallOptions): Promise<number> {
  console.log("\n🧠 opencode-supermemory installer\n");

  writeInstallDefaults(existsSync(DEFAULT_CONFIG_FILE));

  const rl = options.tui ? createReadline() : null;

  // Step 1: Register plugin in config
  console.log("Step 1: Register plugin in OpenCode config");
  const configPath = findOpencodeConfig();
  
  if (configPath) {
    if (options.tui) {
      const shouldModify = await confirm(rl!, `Add plugin to ${configPath}?`);
      if (!shouldModify) {
        console.log("Skipped.");
      } else {
        addPluginToConfig(configPath);
      }
    } else {
      addPluginToConfig(configPath);
    }
  } else {
    if (options.tui) {
      const shouldCreate = await confirm(rl!, "No OpenCode config found. Create one?");
      if (!shouldCreate) {
        console.log("Skipped.");
      } else {
        createNewConfig();
      }
    } else {
      createNewConfig();
    }
  }

  configureTuiPlugin();

  // Step 2: Keep authentication and diagnostics discoverable. Memory tools come from MCP.
  console.log("\nStep 2: Configure /supermemory-login and /supermemory-status");
  configureCommands();

  // Step 3: Configure Oh My OpenCode (if installed)
  if (isOhMyOpencodeInstalled()) {
    console.log("\nStep 3: Configure Oh My OpenCode");
    console.log("Detected Oh My OpenCode plugin.");
    console.log("Supermemory handles context compaction, so the built-in context-window-limit-recovery hook should be disabled.");
    
    if (isAutoCompactAlreadyDisabled()) {
      console.log("✓ anthropic-context-window-limit-recovery hook already disabled");
    } else {
      if (options.tui) {
        const shouldDisable = await confirm(rl!, "Disable anthropic-context-window-limit-recovery hook to let Supermemory handle context?");
        if (!shouldDisable) {
          console.log("Skipped.");
        } else {
          disableAutoCompactHook();
        }
      } else if (options.disableAutoCompact) {
        disableAutoCompactHook();
      } else {
        console.log("Skipped. Use --disable-context-recovery to disable the hook in non-interactive mode.");
      }
    }
  }

  if (rl) rl.close();

  // Step 4: Authenticate
  console.log("\n" + "─".repeat(50));
  console.log("\n🔑 Final step: Authenticate with Supermemory\n");

  if (options.tui) {
    return login();
  }

  // Non-interactive mode - print instructions
  console.log("Run this command to authenticate:");
  console.log("  bunx opencode-supermemory@latest login");
  console.log("\nOr set your API key manually:");
  console.log('  export SUPERMEMORY_API_KEY="sm_..."');
  console.log("\n" + "─".repeat(50));
  console.log("\n✓ Setup complete! Restart OpenCode to activate.\n");
  return 0;
}

async function login(): Promise<number> {
  const existing = loadCredentials();
  if (existing) {
    console.log("Already authenticated. Use 'logout' first to re-authenticate.");
    return 0;
  }

  const result = await startAuthFlow();

  if (result.success) {
    console.log("\n✓ Successfully authenticated with Supermemory!");
    console.log("Restart OpenCode to activate.\n");
    return 0;
  } else {
    console.error(`\n✗ Authentication failed: ${result.error}`);
    return 1;
  }
}

function maskKey(key: string | undefined): string {
  if (!key) return "not set";
  if (key.length <= 12) return `${key.slice(0, 4)}...`;
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function getConfiguredApiKeyFromFile(): string | undefined {
  try {
    if (!existsSync(DEFAULT_CONFIG_FILE)) return undefined;
    const parsed = JSON.parse(readFileSync(DEFAULT_CONFIG_FILE, "utf-8")) as { apiKey?: string };
    return parsed.apiKey;
  } catch {
    return undefined;
  }
}

function getKeySource(): string {
  if (process.env.SUPERMEMORY_API_KEY) return "SUPERMEMORY_API_KEY env var";
  if (getConfiguredApiKeyFromFile()) return DEFAULT_CONFIG_FILE;
  if (loadCredentials()) return CREDENTIALS_FILE;
  return "not configured";
}

function getDevTlsHint(apiUrl: string): string | null {
  if (!apiUrl.includes(".dev.supermemory.ai")) return null;
  return "The saved credential points to a development API endpoint. Do not disable TLS verification; run `bunx opencode-supermemory@latest logout` followed by `bunx opencode-supermemory@latest login` to obtain fresh production credentials.";
}

async function fetchJson(apiUrl: string, path: string): Promise<unknown | null> {
  if (!SUPERMEMORY_API_KEY) return null;
  try {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${SUPERMEMORY_API_KEY}`,
        "x-sm-source": "opencode",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

interface ApiProbe {
  connected: boolean;
  status: number | null;
  detail: string;
}

async function probeApi(apiUrl: string, containerTag: string): Promise<ApiProbe> {
  if (!SUPERMEMORY_API_KEY) {
    return { connected: false, status: null, detail: "not attempted; no API key" };
  }

  try {
    const response = await fetch(`${apiUrl}/v4/profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPERMEMORY_API_KEY}`,
        "Content-Type": "application/json",
        "x-sm-source": "opencode",
      },
      body: JSON.stringify({
        containerTag,
        q: "connectivity probe",
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (response.status === 200 || response.status === 404) {
      return {
        connected: true,
        status: response.status,
        detail: response.status === 200
          ? "reachable, key valid"
          : "reachable, key valid; no profile data yet",
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        connected: false,
        status: response.status,
        detail: "reachable, key rejected",
      };
    }
    return {
      connected: false,
      status: response.status,
      detail: "reachable, unexpected response",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { connected: false, status: null, detail: `network error: ${detail}` };
  }
}

async function getAccountInfo(apiUrl: string): Promise<{ email?: string; name?: string; userId?: string; orgName?: string }> {
  const data = await fetchJson(apiUrl, "/v3/session");
  if (!data || typeof data !== "object") return {};

  const session = data as {
    user?: { email?: unknown; name?: unknown; id?: unknown };
    org?: { name?: unknown };
  };
  return {
    email: typeof session.user?.email === "string" ? session.user.email : undefined,
    name: typeof session.user?.name === "string" ? session.user.name : undefined,
    userId: typeof session.user?.id === "string" ? session.user.id : undefined,
    orgName: typeof session.org?.name === "string" ? session.org.name : undefined,
  };
}

async function status(): Promise<number> {
  const apiUrl = getApiBaseUrl();
  const tags = getTags(process.cwd());
  const lines: string[] = [];

  lines.push("supermemory status");
  lines.push("");
  lines.push(`Authenticated: ${isConfigured() ? "yes" : "no"}`);
  lines.push(`Connected: ${isConfigured() ? "checking..." : "no"}`);
  lines.push(`API key: ${maskKey(SUPERMEMORY_API_KEY)} (${getKeySource()})`);
  lines.push(`API URL: ${apiUrl}`);
  lines.push("Memory scope: one project container with metadata scopes");
  lines.push(`Auto-recall: ${CONFIG.recallMode === "direct" ? "on" : CONFIG.recallMode}`);
  lines.push(`Auto-capture: ${CONFIG.captureEveryNTurns > 0 ? `every ${CONFIG.captureEveryNTurns} completed turn${CONFIG.captureEveryNTurns === 1 ? "" : "s"}` : "at session end"}`);
  lines.push(`Project container: ${tags.canonical}`);
  lines.push(`Reads (including legacy): ${tags.allReads.join(", ")}`);
  lines.push("MCP registration: enabled by the plugin");

  if (!isConfigured()) {
    lines.push("");
    lines.push("Run `bunx opencode-supermemory@latest login` to connect, then restart OpenCode.");
    console.log(lines.join("\n"));
    return 0;
  }

  const [apiProbe, accountInfo] = await Promise.all([
    probeApi(apiUrl, tags.canonical),
    getAccountInfo(apiUrl),
  ]);

  lines[3] = `Connected: ${apiProbe.connected ? "yes" : "no"}`;
  lines.push(`API reachability: ${apiProbe.status ?? "unavailable"} — ${apiProbe.detail}`);

  if (accountInfo.email || accountInfo.name || accountInfo.userId || accountInfo.orgName) {
    lines.push("");
    lines.push("Account:");
    if (accountInfo.email) lines.push(`Email: ${accountInfo.email}`);
    if (accountInfo.name) lines.push(`Name: ${accountInfo.name}`);
    if (accountInfo.userId) lines.push(`User ID: ${accountInfo.userId}`);
    if (accountInfo.orgName) lines.push(`Organization: ${accountInfo.orgName}`);
  } else {
    lines.push("");
    lines.push("Account: authenticated API key (account details unavailable from API key)");
  }

  if (!apiProbe.connected) {
    const devTlsHint = getDevTlsHint(apiUrl);
    if (devTlsHint) {
      lines.push("");
      lines.push(devTlsHint);
    }
  }

  console.log(lines.join("\n"));
  return 0;
}

function logout(): number {
  if (clearCredentials()) {
    console.log("✓ Logged out. Credentials cleared.");
    console.log("This only logs out this local OpenCode install. To revoke the account-level OpenCode integration key, disconnect it from the Supermemory integrations page.");
    if (process.env.SUPERMEMORY_API_KEY) {
      console.log("SUPERMEMORY_API_KEY is still set in this shell, so memory may remain active until you unset it or restart OpenCode.");
    }
    return 0;
  } else {
    console.log("No credentials found.");
    if (process.env.SUPERMEMORY_API_KEY) {
      console.log("SUPERMEMORY_API_KEY is still set in this shell.");
    }
    return 0;
  }
}

function printHelp(): void {
  console.log(`
opencode-supermemory - Persistent memory for OpenCode agents

Commands:
  install    Install and configure the plugin
    --no-tui                     Non-interactive mode (for LLM agents)
    --disable-context-recovery   Disable Oh My OpenCode's context hook
  login      Authenticate with Supermemory (opens browser)
  logout     Clear stored credentials
  status     Show Supermemory connection status

Examples:
  bunx opencode-supermemory@latest install
  bunx opencode-supermemory@latest login
  bunx opencode-supermemory@latest logout
  bunx opencode-supermemory@latest status
`);
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
  printHelp();
  process.exit(0);
}

if (args[0] === "install") {
  const noTui = args.includes("--no-tui");
  const disableAutoCompact = args.includes("--disable-context-recovery");
  install({ tui: !noTui, disableAutoCompact }).then((code) => process.exit(code));
} else if (args[0] === "setup") {
  console.log("Note: 'setup' is deprecated. Use 'install' instead.\n");
  const noTui = args.includes("--no-tui");
  const disableAutoCompact = args.includes("--disable-context-recovery");
  install({ tui: !noTui, disableAutoCompact }).then((code) => process.exit(code));
} else if (args[0] === "login") {
  login().then((code) => process.exit(code));
} else if (args[0] === "logout") {
  process.exit(logout());
} else if (args[0] === "status") {
  status().then((code) => process.exit(code));
} else {
  console.error(`Unknown command: ${args[0]}`);
  printHelp();
  process.exit(1);
}
