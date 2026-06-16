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

- User profile (cross-project preferences)
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

On **every** turn, the agent is shown a short directive asking it to silently decide whether recalling saved memory would improve its answer to *this* message - and if so, to search before responding. The decision is the model's, per message:

- **Recalls** when you refer to earlier work ("the auth flow", "like we did", "continue"), touch an area where saved conventions likely exist, or ask something past context would clarify.
- **Skips** trivial, self-contained, greeting/meta, or already-answered messages.

The search runs through the `supermemory` tool in `search` mode and is auto-approved, so it stays as silent as the save path. No network call happens until the model actually decides to recall.

Customize the directive with the `recallDirective` config option. Set `SUPERMEMORY_DEBUG=1` to make the agent prefix each reply with one line - `[recall-decision] yes|no — <reason>` - so you can see when recall fires and why.

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

**Scopes:** `user` (cross-project), `project` (default)

**Types:** `project-config`, `architecture`, `error-solution`, `preference`, `learned-pattern`, `conversation`

## Memory Scoping

| Scope   | Tag                                    | Persists     |
| ------- | -------------------------------------- | ------------ |
| User    | `opencode_user_{sha256(git email)}`    | All projects |
| Project | `opencode_project_{sha256(directory)}` | This project |

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

  // Prefix for container tags (used when userContainerTag/projectContainerTag not set)
  "containerTagPrefix": "opencode",

  // Optional: Set exact user container tag (overrides auto-generated tag)
  "userContainerTag": "my-custom-user-tag",

  // Optional: Set exact project container tag (overrides auto-generated tag)
  "projectContainerTag": "my-project-tag",

  // Extra keyword patterns for memory detection (regex)
  "keywordPatterns": ["log\\s+this", "write\\s+down"],

  // Context usage ratio that triggers compaction (0-1)
  "compactionThreshold": 0.8,

  // Override the reasoned-recall directive shown to the agent each turn
  // (null or unset = built-in default)
  "recallDirective": null,
}
```

All fields optional. Env var `SUPERMEMORY_API_KEY` takes precedence over config file.

### Container Tag Selection

By default, container tags are auto-generated using `containerTagPrefix` plus a hash:

- User tag: `{prefix}_user_{hash(git_email)}`
- Project tag: `{prefix}_project_{hash(directory)}`

You can override this by specifying exact container tags:

```jsonc
{
  // Use a specific container tag for user memories
  "userContainerTag": "my-team-workspace",

  // Use a specific container tag for project memories
  "projectContainerTag": "my-awesome-project",
}
```

This is useful when you want to:

- Share memories across team members (same `userContainerTag`)
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
