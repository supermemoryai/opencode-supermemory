# opencode-supermemory

OpenCode plugin for persistent memory using [Supermemory](https://supermemory.ai).

Your agent remembers what you tell it - across sessions, across projects.

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

- Register the plugin in `~/.config/opencode/opencode.jsonc`
- Create the `/supermemory-init` command

#### Step 2: Verify the config

```bash
cat ~/.config/opencode/opencode.jsonc
```

Should contain:

```json
{
  "plugin": ["opencode-supermemory"]
}
```

If not, add it manually:

**JSONC:**

```jsonc
{
  "plugin": [
    "opencode-supermemory",
    // ... other plugins
  ],
}
```

**JSON:**

```json
{
  "plugin": ["opencode-supermemory"]
}
```

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
2. Is the plugin in `opencode.jsonc`?
3. Check logs: `tail ~/.opencode-supermemory.log`

#### Step 5: Initialize codebase memory (optional)

Run `/supermemory-init` to have the agent explore and memorize the codebase.

</details>

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

Recall uses the `supermemory` tool in `search` mode and is auto-approved.
Customize the directive with `recallDirective`. Set `SUPERMEMORY_DEBUG=1` to
show a `[recall-decision]` line in each reply while testing.

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

### Preemptive Compaction

When context hits 80% capacity:

1. Triggers OpenCode's summarization
2. Injects project memories into summary context
3. Saves session summary as a memory

This preserves conversation context across compaction events.

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
Codex. Personal and project memories are distinguished with `agent_scope`
metadata inside the shared repository container.

> **Release dependency:** Release this plugin version only after the backend
> `sm_scope` to `agent_scope` backfill has deployed and completed. Canonical
> container reads filter only on `agent_scope`; legacy containers intentionally
> remain unfiltered for backward compatibility.

## Memory Scoping

| Scope   | Tag                                         | Metadata                |
| ------- | ------------------------------------------- | ----------------------- |
| User    | `repo_{project-name}__{repository-hash}`    | `agent_scope: "personal"`  |
| Project | `repo_{project-name}__{repository-hash}`    | `agent_scope: "project"`   |

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

  // Context usage ratio that triggers compaction (0-1)
  "compactionThreshold": 0.8,

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

If you're using [Oh My OpenCode](https://github.com/code-yeongyu/oh-my-opencode), disable its built-in auto-compact hook to let supermemory handle context compaction:

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

Local install:

```jsonc
{
  "plugin": ["file:///path/to/opencode-supermemory"],
}
```

## Logs

```bash
tail -f ~/.opencode-supermemory.log
```

## License

MIT
