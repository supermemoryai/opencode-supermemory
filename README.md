<div align="center">

# opencode-supermemory

**Persistent memory for OpenCode, powered by [Supermemory](https://supermemory.ai)**

[![npm version](https://img.shields.io/npm/v/opencode-supermemory?color=9C5C10&label=npm)](https://www.npmjs.com/package/opencode-supermemory)
[![license](https://img.shields.io/badge/license-MIT-9C5C10)](#license)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-9C5C10)](https://github.com/supermemoryai/opencode-supermemory)

</div>

OpenCode plugin for persistent memory using [Supermemory](https://supermemory.ai). Your
agent remembers what you tell it, across sessions and across projects.

<div align="center">

[Installation](#installation) · [Features](#features) · [Tool usage](#tool-usage) · [Memory scoping](#memory-scoping) · [Configuration](#configuration) · [License](#license)

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

`install`, `login`, `logout`, and `status` are also available as in-chat commands
(`/supermemory-init`, `/supermemory-login`, `/supermemory-logout`, `/supermemory-status`)
once the plugin is registered.

<details>
<summary>Instructions for LLM agents</summary>
<br>

If you're an LLM agent helping set up opencode-supermemory, follow these steps:

**Step 1: Run the installer**

```bash
bunx opencode-supermemory@latest install --no-tui
```

This registers the plugin in `~/.config/opencode/opencode.jsonc` and creates the
`/supermemory-init` command. Add `--disable-context-recovery` if the user also has
[Oh My OpenCode](#usage-with-oh-my-opencode) installed, to avoid its auto-compact hook
fighting with this plugin's compaction.

**Step 2: Verify the config**

```bash
cat ~/.config/opencode/opencode.jsonc
```

Should contain `"plugin": ["opencode-supermemory"]`. If not, add it manually:

```jsonc
{
  "plugin": [
    "opencode-supermemory",
    // ... other plugins
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

Tell the user to restart OpenCode and run `bunx opencode-supermemory@latest status`. If
it's not connected, check: the user is authenticated (or `SUPERMEMORY_API_KEY` is set),
the plugin is in `opencode.jsonc`, and `~/.opencode-supermemory.log` for errors.

**Step 5: Initialize codebase memory (optional)**

Run `/supermemory-init` to have the agent explore and memorize the codebase.

</details>

## Features

|  |  |
| --- | --- |
| 🧠 **Context injection**<br>On a session's first message, the agent silently receives your profile, all project knowledge, and (if `autoRecallEveryPrompt` is on) a semantic search over personal memories. | 🔎 **Reasoned recall**<br>Every turn, the agent is shown a directive asking it to decide whether recalling memory would help before answering. It searches via the `supermemory` tool only when it decides to; the search itself is auto-approved. |
| 💾 **Automatic capture**<br>Completed turns are saved every `captureEveryNTurns` turns, with any remainder flushed when the session ends or OpenCode shuts down. Synthetic plugin context is excluded and `<private>` content is redacted. | 🗣️ **Keyword detection**<br>Saying "remember", "save this", "don't forget", or a custom pattern nudges the agent to save to memory. |
| 🧭 **Codebase indexing**<br>`/supermemory-init` has the agent explore and memorize the codebase's structure, patterns, and conventions. | 🗜️ **Preemptive compaction**<br>At 80% context capacity, triggers OpenCode's summarization, injects project memories into the summary, and saves the summary itself as a memory. |
| 🔒 **Privacy**<br>Content wrapped in `<private>...</private>` is never stored. | 🔔 **Update notices**<br>Checks npm for a newer release on session start and surfaces a one-line notice. |

```
[SUPERMEMORY]

User Profile:
- Prefers concise responses
- Expert in TypeScript

Project Knowledge:
- [100%] Uses Bun, not Node.js
- [100%] Build: bun run build

Relevant Memories:
- [82%] Build fails if .env.local missing
```

That's what the agent sees on the first message, invisible to you, used automatically
with no manual prompting needed.

Set `SUPERMEMORY_DEBUG=1` to show a `[recall-decision]` line in each reply while testing
recall.

## Tool usage

The `supermemory` tool is available to the agent:

| Mode | Args | Description |
| --- | --- | --- |
| `add` | `content`, `type?`, `scope?` | Store memory |
| `search` | `query`, `scope?` | Search memories |
| `profile` | `query?` | View user profile |
| `list` | `scope?`, `limit?` | List memories |
| `forget` | `memoryId`, `scope?` | Delete memory |
| `help` | none | List available modes |

**Scopes:** `user` (personal memories for the current project), `project` (default)

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
| `SUPERMEMORY_REPO_TAG` | Explicit project-container override, checked before the config value. |
| `SUPERMEMORY_ISOLATE_WORKTREES` | Set to `true` to key the project container on the worktree path instead of the Git remote. |
| `SUPERMEMORY_DEBUG` | Set to show `[recall-decision]` lines and enable debug logging. |

### `~/.config/opencode/supermemory.jsonc`

```jsonc
{
  // API key (can also use SUPERMEMORY_API_KEY env var)
  "apiKey": "sm_...",

  // Supermemory API base URL (point at a self-hosted instance, e.g. http://localhost:8787)
  "baseUrl": "https://api.supermemory.ai",

  // Min similarity for memory retrieval (0-1)
  "similarityThreshold": 0.55,

  // Max memories injected per request
  "maxMemories": 5,

  // Max project memories listed
  "maxProjectMemories": 10,

  // Max profile facts injected
  "maxProfileItems": 5,

  // Include user profile in context
  "injectProfile": true,

  // Also run a semantic search over personal memories on a session's first
  // message, not just profile + project list (default: true on upgrades,
  // false on fresh installs)
  "autoRecallEveryPrompt": true,

  // Legacy prefix retained when reading containers made by older versions
  "containerTagPrefix": "opencode",

  // Optional legacy personal container to keep reading
  "userContainerTag": "my-custom-user-tag",

  // Optional: set exact project container tag (overrides auto-generated tag)
  "projectContainerTag": "my-project-tag",

  // Extra keyword patterns for memory detection (regex)
  "keywordPatterns": ["log\\s+this", "write\\s+down"],

  // Context usage ratio that triggers compaction (0-1)
  "compactionThreshold": 0.8,

  // Save completed conversation batches every N turns (0 = session end only)
  "captureEveryNTurns": 3,

  // Override the reasoned-recall directive shown to the agent each turn
  // (null or unset = built-in default)
  "recallDirective": null,
}
```

All fields optional.

### Container tag selection

By default, new writes use:

- Repository tag: `repo_{project-name}__{hash(normalized-origin-remote)}`
- No origin remote: `repo_{project-name}__{hash(real-repository-path)}`

Older `{prefix}_user_*` and `{prefix}_project_*` containers remain readable.
`userContainerTag` is treated as a legacy personal read. You can still override the
unified write container with `projectContainerTag`:

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

Local install:

```jsonc
{
  "plugin": ["file:///path/to/opencode-supermemory"],
}
```

Logs:

```bash
tail -f ~/.opencode-supermemory.log
```

</details>

## License

MIT
