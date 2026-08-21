# opencode-supermemory

OpenCode plugin for persistent memory using [Supermemory](https://supermemory.ai).

Your agent remembers what you tell it - across sessions, across projects.

One package supports both OpenCode generations. OpenCode V1 loads
`opencode-supermemory`; the OpenCode 2 beta loads `opencode-supermemory/v2`.
The initial V2 adapter targets `@opencode-ai/plugin` beta `0.0.0-beta-17728`.
Use the `opencode` binary for V1 and `opencode2` for the beta while testing both.

## Installation

### For Humans

```bash
bunx opencode-supermemory@latest install
```

Then authenticate with Supermemory:

```bash
bunx opencode-supermemory@latest login
```

Check the connection any time:

```bash
bunx opencode-supermemory@latest status
```

**Or let your agent do it** - paste this into OpenCode:

```
Install opencode-supermemory by following https://raw.githubusercontent.com/supermemoryai/opencode-supermemory/main/README.md
```

### For LLM Agents

<details>
<summary>Instructions for LLM Agents (click to expand)</summary>

If you're an LLM agent helping set up opencode-supermemory, follow these steps:

#### Step 1: Run the installer

```bash
bunx opencode-supermemory@latest install --no-tui
```

This will:

- Register both the V1 and V2 entrypoints in `~/.config/opencode/opencode.jsonc`
- Allow only the V2 `supermemory_recall` helper without prompting
- Create the `/supermemory-init` command

#### Step 2: Verify the config

```bash
cat ~/.config/opencode/opencode.jsonc
```

Should contain:

```json
{
  "plugin": ["opencode-supermemory@latest"],
  "plugins": ["opencode-supermemory/v2"],
  "permissions": [
    {
      "action": "supermemory_recall",
      "resource": "*",
      "effect": "allow"
    }
  ]
}
```

OpenCode V1 reads the singular `plugin` entry. OpenCode 2 reads the plural
`plugins` entry and loads the V2 adapter. Both entrypoints ship in the same npm
package and use the same Supermemory account and configuration.

If not, add it manually:

**JSONC:**

```jsonc
{
  "plugin": [
    "opencode-supermemory@latest",
    // ... other plugins
  ],
  "plugins": [
    "opencode-supermemory/v2",
    // ... other OpenCode 2 plugins
  ],
  "permissions": [
    {
      "action": "supermemory_recall",
      "resource": "*",
      "effect": "allow",
    },
  ],
}
```

**JSON:**

```json
{
  "plugin": ["opencode-supermemory@latest"],
  "plugins": ["opencode-supermemory/v2"],
  "permissions": [
    {
      "action": "supermemory_recall",
      "resource": "*",
      "effect": "allow"
    }
  ]
}
```

The installer preserves comments, existing plugins, permissions, and unrelated
settings. Running it again is safe. If `supermemory_recall` is explicitly
denied, the installer keeps that deny and prints a warning instead of
overriding it.

#### Step 3: Authenticate

Run the browser authentication flow:

```bash
bunx opencode-supermemory@latest login
```

For headless environments, users can still set `SUPERMEMORY_API_KEY` manually or create `~/.config/opencode/supermemory.jsonc`:

```jsonc
{
  "apiKey": "sm_...",
}
```

#### Step 4: Verify setup

Tell the user to restart OpenCode and run:

```bash
bunx opencode-supermemory@latest status
```

If it is not connected, check:

1. Is the user authenticated, or is `SUPERMEMORY_API_KEY` set?
2. Does `opencode.jsonc` contain the V1 `plugin` and V2 `plugins` entries shown above?
3. Check logs: `tail ~/.opencode-supermemory.log`

#### Step 5: Initialize codebase memory (optional)

Run `/supermemory-init` to have the agent explore and memorize the codebase.

</details>

### OpenCode 2 rollback

To stop loading the beta adapter without affecting OpenCode V1, remove only
`"opencode-supermemory/v2"` from the plural `plugins` array and restart
OpenCode 2. The singular `plugin` entry continues to load the V1 adapter. The
recall permission may remain in the file; it has no effect when the V2 adapter
is not loaded.

## Features

### Context Injection

On first message, the agent receives (invisible to user):

- Personal profile for the current project
- Project memories (all project knowledge)
- Relevant user memories (semantic search)

Example of what the agent sees:

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

The agent uses this context automatically - no manual prompting needed.

### Reasoned Recall

On **every** turn, the agent is shown a short directive asking it to silently
decide whether recalling saved memory would improve its answer to *this*
message. The model searches only when earlier work, saved conventions, or user
preferences are likely to help; trivial and self-contained messages skip the
network call.

On V1, recall uses the `supermemory` tool in `search` mode. On OpenCode 2, it
uses the search-only `supermemory_recall` helper, which is the only V2 action
the installer auto-allows. Add and forget operations remain behind the normal
`supermemory` permission. Customize the directive with `recallDirective`. Set
`SUPERMEMORY_DEBUG=1` to show a `[recall-decision]` line in each reply while
testing.

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

Run `/supermemory-init` to explore and memorize your codebase structure, patterns, and conventions.

### Native Compaction Lifecycle

OpenCode decides when to compact, which model to use, and how execution
continues afterward. Supermemory enriches that native lifecycle by injecting
bounded project memory into compaction context and saving only successful
session summaries. It does not trigger compaction or override OpenCode's
configured compaction model.

### Privacy

```
API key is <private>sk-abc123</private>
```

Content in `<private>` tags is never stored.

## Tool Usage

The `supermemory` tool is available to the agent:

| Mode      | Args                         | Description       |
| --------- | ---------------------------- | ----------------- |
| `add`     | `content`, `type?`, `scope?` | Store memory      |
| `search`  | `query`, `scope?`            | Search memories   |
| `profile` | `query?`                     | View user profile |
| `list`    | `scope?`, `limit?`           | List memories     |
| `forget`  | `memoryId`, `scope?`         | Delete memory     |

**Scopes:** `user` (personal memories for the current project), `project` (default)

**Types:** `project-config`, `architecture`, `error-solution`, `preference`, `learned-pattern`, `conversation`

OpenCode sends the same shared coding-agent entity context as Claude Code and
Codex. Personal and project memories are distinguished with `sm_scope`
metadata inside the shared repository container.

## Memory Scoping

| Scope   | Tag                                         | Metadata                |
| ------- | ------------------------------------------- | ----------------------- |
| User    | `repo_{project-name}__{repository-hash}`    | `sm_scope: "personal"`  |
| Project | `repo_{project-name}__{repository-hash}`    | `sm_scope: "project"`   |

The repository hash comes from the normalized Git `origin` remote, so Claude
Code, Codex, and OpenCode use the same container for the same repository.
Repositories with the same name but different remotes remain isolated. Without
an origin remote, OpenCode falls back to the repository's real filesystem path.
OpenCode also reads previous `user_project_*`, `repo_<project-name>`,
`claudecode_project_*`, `codex_user_*`, `codex_project_*`, `opencode_user_*`,
and `opencode_project_*` containers, so upgrading does not require a migration.

## Configuration

Create `~/.config/opencode/supermemory.jsonc`:

```jsonc
{
  // API key (can also use SUPERMEMORY_API_KEY env var)
  "apiKey": "sm_...",

  // Supermemory API base URL (point at a self-hosted instance, e.g. http://localhost:8787)
  "baseUrl": "https://api.supermemory.ai",

  // Min similarity for memory retrieval (0-1)
  "similarityThreshold": 0.6,

  // Max memories injected per request
  "maxMemories": 5,

  // Max project memories listed
  "maxProjectMemories": 10,

  // Max profile facts injected
  "maxProfileItems": 5,

  // Include user profile in context
  "injectProfile": true,

  // Legacy prefix retained when reading containers made by older versions
  "containerTagPrefix": "opencode",

  // Optional legacy personal container to keep reading
  "userContainerTag": "my-custom-user-tag",

  // Optional: Set exact project container tag (overrides auto-generated tag)
  "projectContainerTag": "my-project-tag",

  // Extra keyword patterns for memory detection (regex)
  "keywordPatterns": ["log\\s+this", "write\\s+down"],

  // Enrich OpenCode's native compaction lifecycle with Supermemory
  "compactionEnabled": true,

  // Save completed conversation batches every N turns (0 = session end only)
  "captureEveryNTurns": 3,

  // Override the reasoned-recall directive shown to the agent each turn
  // (null or unset = built-in default)
  "recallDirective": null,
}
```

All fields optional. Env var `SUPERMEMORY_API_KEY` takes precedence over config file.

### Container Tag Selection

By default, new writes use:

- Repository tag: `repo_{project-name}__{hash(normalized-origin-remote)}`
- No origin remote: `repo_{project-name}__{hash(real-repository-path)}`

Older `{prefix}_user_*` and `{prefix}_project_*` containers remain readable.
`userContainerTag` is treated as a legacy personal read. You can still override
the unified write container with `projectContainerTag`:

```jsonc
{
  // Continue reading a personal container made by an older version
  "userContainerTag": "my-team-workspace",

  // Override the unified container used for new writes
  "projectContainerTag": "my-awesome-project",
}
```

This is useful when you want to:

- Preserve a legacy personal memory container
- Sync memories between different machines for the same project
- Organize memories using your own naming scheme
- Integrate with existing Supermemory container tags from other tools

## Usage with Oh My OpenCode

If you're using [Oh My OpenCode](https://github.com/code-yeongyu/oh-my-opencode), disable its built-in auto-compact hook so it does not compete with OpenCode's native compaction lifecycle:

Add to `~/.config/opencode/oh-my-opencode.json`:

```json
{
  "disabled_hooks": ["anthropic-context-window-limit-recovery"]
}
```

## Development

```bash
bun install
bun run build
bun run typecheck
```

Local install after building:

```jsonc
{
  "plugin": ["file:///path/to/opencode-supermemory"],
  "plugins": [
    "file:///path/to/opencode-supermemory/dist/v2/index.js",
  ],
}
```

Launch `opencode` to test the V1 entry and `opencode2` to test the V2 entry.
The direct built-file URL is for local development only; the published package
uses the stable `opencode-supermemory/v2` export shown above.

## Logs

```bash
tail -f ~/.opencode-supermemory.log
```

## License

MIT
