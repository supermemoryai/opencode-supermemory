import { CONFIG } from "../config.js";
import { log } from "./logger.js";

export type SessionSkipReason = "subagent" | "headless" | "orchestrated";

export type SessionScopeConfig = Pick<
  typeof CONFIG,
  "captureSubagents" | "captureHeadless" | "captureOrchestrated"
>;

// Conductor (conductor.build/docs/reference/environment-variables) and Vibe Kanban
// (BloopAI/vibe-kanban crates/local-deployment/src/container.rs) set these for agents they run.
const ORCHESTRATOR_ENV_VARS = [
  "CONDUCTOR_WORKSPACE_PATH",
  "CONDUCTOR_SESSION_ID",
  "VK_WORKSPACE_ID",
] as const;

// Global and default-command flags of opencode V1 (1.19) that take a value.
const VALUE_FLAGS = new Set([
  "--log-level",
  "--port",
  "--hostname",
  "--mdns-domain",
  "--cors",
  "-m",
  "--model",
  "-s",
  "--session",
  "--prompt",
  "--agent",
  "--replay-limit",
]);

export const PARENT_LOOKUP_TIMEOUT_MS = 2_000;

export function isOrchestrated(env: NodeJS.ProcessEnv = process.env): boolean {
  return ORCHESTRATOR_ENV_VARS.some((name) => Boolean(env[name]?.trim()));
}

/**
 * OpenCode V1 runs `opencode run` and `opencode github run` with the server and
 * plugins in the CLI process (packages/opencode/src/cli/cmd/run.ts, github.ts).
 */
export function isHeadlessCommand(argv: readonly string[] = process.argv): boolean {
  const positionals: string[] = [];
  const args = argv.slice(2);
  for (let index = 0; index < args.length && positionals.length < 2; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") break;
    if (VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) positionals.push(arg);
  }
  return (
    positionals[0] === "run" ||
    (positionals[0] === "github" && positionals[1] === "run")
  );
}

export function getProcessSkipReason(options: {
  config: SessionScopeConfig;
  headless: boolean;
  env?: NodeJS.ProcessEnv;
}): SessionSkipReason | null {
  if (isOrchestrated(options.env)) {
    return options.config.captureOrchestrated ? null : "orchestrated";
  }
  return options.headless && !options.config.captureHeadless ? "headless" : null;
}

/**
 * Decides whether a session gets automatic recall and capture. Child sessions
 * (`parentID` set by the host's task/subagent tool) and headless runs are
 * skipped unless the matching opt-in flag is set.
 */
export class SessionScope {
  readonly #config: SessionScopeConfig;
  readonly #processReason: SessionSkipReason | null;
  readonly #lookupParent: (sessionID: string) => Promise<string | undefined>;
  readonly #lookupTimeoutMs: number;
  readonly #children = new Map<string, Promise<boolean>>();
  readonly #logged = new Set<string>();

  constructor(options: {
    lookupParent: (sessionID: string) => Promise<string | undefined>;
    headless: boolean;
    config?: SessionScopeConfig;
    env?: NodeJS.ProcessEnv;
    lookupTimeoutMs?: number;
  }) {
    this.#config = options.config ?? CONFIG;
    this.#lookupParent = options.lookupParent;
    this.#lookupTimeoutMs = options.lookupTimeoutMs ?? PARENT_LOOKUP_TIMEOUT_MS;
    this.#processReason = getProcessSkipReason({
      config: this.#config,
      headless: options.headless,
      env: options.env,
    });
    if (this.#processReason) {
      log("Automatic memory disabled for this process", { reason: this.#processReason });
    }
  }

  get processSkipReason(): SessionSkipReason | null {
    return this.#processReason;
  }

  note(sessionID: string | undefined, parentID: string | undefined): void {
    if (sessionID && !this.#children.has(sessionID)) {
      this.#children.set(sessionID, Promise.resolve(Boolean(parentID)));
    }
  }

  forget(sessionID: string): void {
    this.#children.delete(sessionID);
    this.#logged.delete(sessionID);
  }

  async skipReason(sessionID: string): Promise<SessionSkipReason | null> {
    if (this.#processReason) return this.#processReason;
    if (this.#config.captureSubagents) return null;

    let isChild = this.#children.get(sessionID);
    if (!isChild) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      isChild = Promise.race([
        Promise.resolve().then(() => this.#lookupParent(sessionID)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("OpenCode session lookup timed out")),
            this.#lookupTimeoutMs,
          );
        }),
      ])
        .finally(() => clearTimeout(timer))
        .then(
          (parentID) => Boolean(parentID),
          () => {
            this.#children.delete(sessionID);
            return false;
          },
        );
      this.#children.set(sessionID, isChild);
    }
    if (!(await isChild)) return null;

    if (!this.#logged.has(sessionID)) {
      this.#logged.add(sessionID);
      log("Automatic memory skipped for subagent session", { sessionID });
    }
    return "subagent";
  }
}
