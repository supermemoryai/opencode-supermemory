<div align="center">

# opencode-supermemory

**Persistent memory for OpenCode, powered by [Supermemory](https://supermemory.ai)**

[![npm version](https://img.shields.io/npm/v/opencode-supermemory?color=9C5C10&label=npm)](https://www.npmjs.com/package/opencode-supermemory)
[![license](https://img.shields.io/badge/license-MIT-9C5C10)](#license)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-9C5C10)](https://github.com/supermemoryai/opencode-supermemory)

</div>

OpenCode plugin for persistent memory using [Supermemory](https://supermemory.ai). Your
agent remembers what you tell it, across sessions and across projects.

One package supports both OpenCode generations: OpenCode V1 loads the root entry from
the `plugin` array, and OpenCode 2 loads `opencode-supermemory/server` (plus a small TUI
companion for notices) from the `plugins` array. See [OpenCode 2](#opencode-2).

<div align="center">

[Installation](#installation) · [OpenCode 2](#opencode-2) · [Features](#features) · [Tool usage](#tool-usage) · [Memory scoping](#memory-scoping) · [Configuration](#configuration) · [License](#license)

</div>

---

## Installation

```bash
bunx opencode-supermemory@latest install
bunx opencode-supermemory@latest login     # or set SUPERMEMORY_API_KEY
bunx opencode-supermemory@latest status    # check the connection any time
```

**Or let your agent do it:** paste this into OpenCode:

```
Install opencode-supermemory by following https://raw.githubusercontent.com/supermemoryai/opencode-supermemory/main/README.md
```

`login`, `logout`, and `status` are also available as in-chat commands
(`/supermemory-login`, `/supermemory-logout`, `/supermemory-status`) once the plugin is
registered, and `/supermemory-index` (alias `/supermemory-init`) indexes the codebase.

<details>
<summary>Instructions for LLM agents</summary>
<br>

If you're an LLM agent helping set up opencode-supermemory, follow these steps:

**Step 1: Run the installer**

```bash
bunx opencode-supermemory@latest install --no-tui
```

The installer creates `~/.config/opencode` if needed and then:

- Registers the plugin in `~/.config/opencode/opencode.jsonc` (`plugin` for V1, `plugins`
  for OpenCode 2, plus an `allow` rule for the read-only `supermemory_recall` tool)
- Enables the V1 status footer in `~/.config/opencode/tui.jsonc`
- Writes defaults into the existing `supermemory.jsonc`/`supermemory.json` (or creates
  `supermemory.json`), preserving comments and any keys already there
- Creates the `/supermemory-index`, `/supermemory-init`, `/supermemory-login`,
  `/supermemory-logout`, and `/supermemory-status` commands

Add `--disable-context-recovery` if the user also has
[Oh My OpenCode](#usage-with-oh-my-opencode) installed, to avoid its auto-compact hook
fighting with this plugin's V1 compaction.

#### Step 2: Verify the config

```bash
cat ~/.config/opencode/opencode.jsonc
```

Should contain the entries below. The installer preserves comments and other settings and
is safe to re-run; if anything is missing, add it manually:

```jsonc
{
  // OpenCode V1
  "plugin": [
    "opencode-supermemory@latest",
    // ... other plugins
  ],
  // OpenCode 2
  "plugins": [
    "opencode-supermemory",
    // ... other OpenCode 2 plugins
  ],
  "permissions": [
    { "action": "supermemory_recall", "resource": "*", "effect": "allow" },
  ],
}
```

**Step 3: Authenticate**

```bash
bunx opencode-supermemory@latest login
```

For headless environments, set `SUPERMEMORY_API_KEY` manually, or create
`~/.config/opencode/supermemory.jsonc`:

```jsonc
{
  "apiKey": "sm_...",
}
```

**Step 4: Verify setup**

Tell the user to restart OpenCode and run `bunx opencode-supermemory@latest status`. The
status output lists whether the V1 and OpenCode 2 entries are registered. If it's not
connected, check: the user is authenticated (or `SUPERMEMORY_API_KEY` is set), the plugin
is in `opencode.jsonc`, `opencode plugin list` shows `supermemory` on OpenCode 2, and
`~/.opencode-supermemory.log` for errors.

**Step 5: Initialize codebase memory (optional)**

Run `/supermemory-index` to have the agent explore and memorize the codebase. `/supermemory-init` is an alias.

</details>

## Features

|  |  |
| --- | --- |
| 🧠 **Profile context**<br>On a session's first message, the agent silently receives your Supermemory profile: stable facts about you plus recent context. Everything else is recalled per prompt. | 🔎 **Direct recall**<br>On every substantive prompt the plugin searches your personal and project memories and injects up to five fresh matches. Set `recallMode: "advisory"` to let the model decide when to search instead; that search is auto-approved. |
| 💾 **Automatic capture**<br>Completed turns are saved every `captureEveryNTurns` turns, with any remainder flushed when the session ends or OpenCode shuts down. Synthetic plugin context is excluded and `<private>` content is redacted. | 🗣️ **Keyword detection**<br>Saying "remember", "save this", "don't forget", or a custom pattern nudges the agent to save to memory. |
| 🧭 **Codebase indexing**<br>`/supermemory-init` has the agent explore and memorize the codebase's structure, patterns, and conventions. | 🗜️ **Compaction memory**<br>On OpenCode V1, triggers summarization at 80% context capacity. On OpenCode 2, enriches the native compaction request. Both inject project memories into the summary and save the summary itself as a memory. |
| 🔒 **Privacy**<br>Content wrapped in `<private>...</private>` is never stored. | 🔔 **Update notices**<br>Checks npm for a newer release on session start and surfaces a one-line notice. |

First message of a session:

```
[SUPERMEMORY]
Every line marked ◪ comes from supermemory. When one shapes your answer, credit it naturally with the ◪ prefix; if you name the source, say "from supermemory".

User Profile:
- ◪ Prefers concise responses
- ◪ Expert in TypeScript

Recent Context:
- ◪ Migrating the auth service to Bun
```

Any substantive prompt (direct recall):

```
<supermemory-context>
Relevant memories automatically recalled for this prompt. Every line marked ◪ comes from supermemory:
- ◪ Uses Bun, not Node.js
- ◪ Build fails if .env.local is missing
Use these memories only when relevant. Search Supermemory for deeper context if needed.
</supermemory-context>
```

The agent uses this context automatically - no manual prompting needed.

### Direct Recall

On every substantive prompt, Supermemory directly searches the current project
and injects up to five strong, fresh matches. Short prompts and commands are
skipped, repeat results are suppressed per session, and recall fails open after
three seconds so it never blocks the agent indefinitely.

Set `recallMode` to `"advisory"` to retain model-decided tool recall, or to
`"off"` to disable automatic recall. `recallDirective` customizes advisory mode.
Legacy `autoRecallEveryPrompt: true` maps to direct mode and `false` maps to
advisory mode when `recallMode` is unset.

### Automatic Capture

Completed conversations are captured automatically:

- Every `captureEveryNTurns` completed turns, OpenCode saves the new turn batch.
- Any remaining turns are flushed when the session is deleted or the OpenCode
  instance shuts down.
- Synthetic plugin context is excluded and `<private>` content is redacted.
- Stable capture IDs make repeated lifecycle events idempotent.

### Keyword Detection

Say "remember", "save this", "don't forget" etc. and the agent auto-saves to memory.

```
You: "Remember that this project uses bun"
Agent: [saves to project memory]
```

Add custom triggers via `keywordPatterns` config.

### Codebase Indexing

Run `/supermemory-index` to explore and memorize your codebase structure, patterns, and conventions. `/supermemory-init` is an alias.

### Compaction Memory

On OpenCode V1, when context hits 80% capacity (`compactionThreshold`) the plugin triggers
OpenCode's summarization, injects project memories into the summary prompt, and saves the
resulting summary as a memory.

On OpenCode 2, OpenCode owns the compaction trigger and model. The plugin hooks the native
compaction request to add the same project memories, then saves each successful summary as
a memory. Set `compactionEnabled: false` to opt out on OpenCode 2.

### Activity Notices and Status Footer

Supermemory shows a short native notice when it recalls memories, saves a turn, falls open
because recall was unavailable, or a newer release exists. Notices never enter model
context. On OpenCode V1 they are TUI toasts; on OpenCode 2 they are rendered by the
`opencode-supermemory/tui` companion, which OpenCode loads automatically next to the
server plugin.

The same TUI plugin keeps a persistent `◪ supermemory` footer. It turns blue while a
session is running and otherwise shows the latest recall or save activity, if any. On OpenCode V1
the installer enables it through `~/.config/opencode/tui.jsonc`; on OpenCode 2 it appears
in the prompt footer without extra configuration.

Set `SUPERMEMORY_DEBUG=1` to show a `[recall-decision]` line in each reply while testing
advisory recall.

## OpenCode 2

OpenCode 2 uses the plural `plugins` config key and the new `@opencode/plugin` API. The
installer writes both generations, so one `opencode.jsonc` works for `opencode` (V1) and
OpenCode 2 side by side:

```jsonc
{
  "plugin": ["opencode-supermemory@latest"],
  "plugins": ["opencode-supermemory"],
  "permissions": [
    { "action": "supermemory_recall", "resource": "*", "effect": "allow" },
  ],
}
```

OpenCode 2 resolves the package's `./server` export for the server plugin (id
`supermemory`) and `./tui` for the notice companion (id `supermemory.tui`). Verify with
`opencode plugin list` (or `v2 plugin registered` in `~/.opencode-supermemory.log`), and
update with `opencode plugin update opencode-supermemory`.

What is the same on both generations:

- Direct recall on substantive prompts, advisory mode, and `recallMode: "off"`
- First-message profile injection, keyword nudges, and automatic capture with the same
  cadence, privacy redaction, and idempotent capture IDs
- The `supermemory` tool with identical modes, scopes, and result formatting
- Activity notices, the persistent status footer, and update checks

What differs on OpenCode 2:

- Recall runs through the read-only `supermemory_recall` tool (search only). The installer
  allows it without prompting; `add`, `forget`, and the rest stay behind the normal
  `supermemory` permission. An explicit `deny` for `supermemory_recall` is preserved.
- Compaction is native: the plugin enriches OpenCode's compaction request and saves the
  summary instead of triggering compaction itself (`compactionEnabled`).
- Recalled context is attached to the outgoing model request for the current prompt rather
  than persisted into the transcript.

To roll back on OpenCode 2 only, remove `"opencode-supermemory"` from `plugins` (or prefix
it with `-`) and restart. The V1 `plugin` entry is unaffected.

## Tool usage

The `supermemory` tool is available to the agent:

| Mode | Args | Description |
| --- | --- | --- |
| `add` | `content`, `type?`, `scope?` | Store memory |
| `search` | `query`, `scope?`, `limit?` | Search memories |
| `profile` | `query?` | View user profile |
| `list` | `scope?`, `limit?` | List memories |
| `forget` | `memoryId`, `scope?` | Delete memory |
| `help` | none | List available modes |

**Scopes:** `user` (personal memories for the current project) and `project`. `search`
without a scope covers both; `add`, `list`, and `forget` default to `project`.

**Types:** `project-config`, `architecture`, `error-solution`, `preference`, `learned-pattern`, `conversation`

OpenCode sends the same shared coding-agent entity context as Claude Code and Codex.
Personal and project memories are distinguished with `sm_scope` metadata inside the
shared repository container.

## Memory scoping

| Scope | Tag | Metadata |
| --- | --- | --- |
| User | `repo_{project-name}__{repository-hash}` | `sm_scope: "personal"` |
| Project | `repo_{project-name}__{repository-hash}` | `sm_scope: "project"` |

The repository hash comes from the normalized Git `origin` remote, so Claude Code,
Codex, Cursor, and OpenCode use the same container for the same repository.
Repositories with the same name but different remotes remain isolated. Without an
origin remote, OpenCode falls back to the repository's real filesystem path.

OpenCode also reads previous `user_project_*`, `repo_<project-name>`,
`claudecode_project_*`, `codex_user_*`, `codex_project_*`, `opencode_user_*`,
`opencode_project_*`, `cursor_user_*`, and `cursor_project_*` containers, so upgrading
does not require a migration.

## Configuration

### Environment variables

| Variable | Purpose |
| --- | --- |
| `SUPERMEMORY_API_KEY` | Your Supermemory API key (takes precedence over the config file). |
| `SUPERMEMORY_API_URL` / `SUPERMEMORY_BASE_URL` | Override the Supermemory API base URL. |
| `SUPERMEMORY_AUTH_URL` | Override the browser-auth base URL. |
| `SUPERMEMORY_AUTH_TIMEOUT` | Browser-auth timeout in milliseconds (default 5 minutes). |
| `SUPERMEMORY_REPO_TAG` | Explicit project-container override (see [precedence](#container-tag-selection)). |
| `SUPERMEMORY_ISOLATE_WORKTREES` | Set to `true` to key the project container on the worktree path instead of the Git remote. |
| `SUPERMEMORY_DEBUG` | In advisory mode, asks the model to print a `[recall-decision]` line each reply. File logging to `~/.opencode-supermemory.log` is always on. |

### `~/.config/opencode/supermemory.jsonc`

```jsonc
{
  // API key (can also use SUPERMEMORY_API_KEY env var)
  "apiKey": "sm_...",

  // Supermemory API base URL (point at a self-hosted instance, e.g. http://localhost:8787)
  "baseUrl": "https://api.supermemory.ai",

  // Min similarity for memory retrieval (0-1)
  "similarityThreshold": 0.55,

  // Results fetched per memory search (tool searches and direct recall reads).
  // Direct recall injects at most 5 after similarity filtering and dedupe.
  "maxMemories": 5,

  // Project memories added to compaction summaries
  "maxProjectMemories": 10,

  // Max profile facts injected
  "maxProfileItems": 5,

  // Include user profile in context
  "injectProfile": true,

  // Legacy switch, only read when recallMode is unset:
  // true maps to "direct", false maps to "advisory"
  "autoRecallEveryPrompt": true,

  // Instructions for Supermemory's server-side LLM filter. When the plugin
  // connects it enables the filter on your account with this prompt.
  "filterPrompt": "You are a stateful coding agent. Remember the user's coding preferences, tech stack, behaviours, and workflows.",

  // Legacy prefix retained when reading containers made by older versions
  "containerTagPrefix": "opencode",

  // Optional legacy personal container to keep reading
  "userContainerTag": "my-custom-user-tag",

  // Optional: set exact project container tag (overrides auto-generated tag)
  "projectContainerTag": "my-project-tag",

  // Extra keyword patterns for memory detection (regex)
  "keywordPatterns": ["log\\s+this", "write\\s+down"],

  // OpenCode V1: context usage ratio that triggers compaction (0-1)
  "compactionThreshold": 0.8,

  // OpenCode 2: enrich native compaction with project memories and save summaries
  "compactionEnabled": true,

  // Save completed conversation batches every N turns (0 = session end only).
  // Default: 0 on fresh installs, 3 when a config file exists without this key.
  "captureEveryNTurns": 3,

  // "direct" (default for new installs), "advisory", or "off"
  "recallMode": "direct",

  // Override the directive used in advisory mode
  "recallDirective": null,
}
```

All fields optional.

### Container tag selection

By default, new writes use:

- Repository tag: `repo_{project-name}__{hash(normalized-origin-remote)}`
- No origin remote: `repo_{project-name}__{hash(real-repository-path)}`

Older `{prefix}_user_*` and `{prefix}_project_*` containers remain readable.
`userContainerTag` is treated as a legacy personal read.

The write container is resolved from the first of these that is set, so a Claude Code or
Cursor project config for the same repository wins over this plugin's own setting:

1. `repoContainerTag` in the repository's `.claude/.supermemory-claude/config.json`
2. `SUPERMEMORY_REPO_TAG`
3. `repoContainerTag` in the repository's legacy Cursor plugin config under `.cursor/`
4. `projectContainerTag` in `~/.config/opencode/supermemory.jsonc`
5. `projectContainerTag` in `~/.codex/supermemory.json`
6. The generated `repo_{project-name}__{hash}` tag

You can still override the unified write container with `projectContainerTag`:

```jsonc
{
  // Continue reading a personal container made by an older version
  "userContainerTag": "my-team-workspace",

  // Override the unified container used for new writes
  "projectContainerTag": "my-awesome-project",
}
```

This is useful to preserve a legacy personal memory container, sync memories between
machines for the same project, organize memories with your own naming scheme, or
integrate with existing Supermemory container tags from other tools.

## Usage with Oh My OpenCode

If you're using [Oh My OpenCode](https://github.com/code-yeongyu/oh-my-opencode),
disable its built-in auto-compact hook to let supermemory handle context compaction
(or pass `--disable-context-recovery` to `install`):

```json
{
  "disabled_hooks": ["anthropic-context-window-limit-recovery"]
}
```

Add that to `~/.config/opencode/oh-my-opencode.json`.

<details>
<summary>Development</summary>
<br>

```bash
bun install
bun run build
bun run typecheck
```

Local install (OpenCode V1 loads the built package; OpenCode 2 loads `server.ts` and
`tui.ts` from the checkout, so `bun install` is enough):

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["file:///path/to/opencode-supermemory"],
  "plugins": ["/path/to/opencode-supermemory"],
}
```

The TUI side of a local checkout is registered separately: OpenCode V1 reads
`~/.config/opencode/tui.jsonc` (`"plugin": ["file:///path/to/opencode-supermemory/dist/tui.js"]`)
and OpenCode 2 reads `~/.config/opencode/cli.json` (`"plugins": ["/path/to/opencode-supermemory"]`).
Published packages need neither; both generations find the `./tui` export on their own.

`opencode plugin list` only shows package plugins, so confirm a checkout loaded by looking
for `v2 plugin init` and `v2 plugin registered` in `~/.opencode-supermemory.log`.

Logs:

```bash
tail -f ~/.opencode-supermemory.log
```

</details>

## License

MIT
