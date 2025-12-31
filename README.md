# opencode-supermemory

OpenCode plugin for persistent memory using [Supermemory](https://supermemory.ai).

Your agent remembers what you tell it - across sessions, across projects.

## Installation

### For Humans

```bash
bunx opencode-supermemory@latest install
```

Then get your API key from [console.supermemory.ai](https://console.supermemory.ai) and set it:

```bash
export SUPERMEMORY_API_KEY="sm_..."
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
    "opencode-supermemory"
    // ... other plugins
  ]
}
```

**JSON:**
```json
{
  "plugin": ["opencode-supermemory"]
}
```

#### Step 3: Configure API key

Ask the user to get their API key from [console.supermemory.ai](https://console.supermemory.ai).

Then set it via environment variable:

```bash
export SUPERMEMORY_API_KEY="sm_..."
```

Or create `~/.config/opencode/supermemory.jsonc`:

```jsonc
{
  "apiKey": "sm_..."
}
```

#### Step 4: Verify setup

Tell the user to restart OpenCode and run:

```bash
opencode -c
```

They should see `supermemory` in the tools list. If not, check:
1. Is `SUPERMEMORY_API_KEY` set?
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

### Keyword Detection

Say "remember", "save this", "don't forget" etc. and the agent auto-saves to memory.

```
You: "Remember that this project uses bun"
Agent: [saves to project memory]
```

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

| Mode | Args | Description |
|------|------|-------------|
| `add` | `content`, `type?`, `scope?` | Store memory |
| `search` | `query`, `scope?` | Search memories |
| `profile` | `query?` | View user profile |
| `list` | `scope?`, `limit?` | List memories |
| `forget` | `memoryId`, `scope?` | Delete memory |

**Scopes:** `user` (cross-project), `project` (default)

**Types:** `project-config`, `architecture`, `error-solution`, `preference`, `learned-pattern`, `conversation`

## Memory Scoping

| Scope | Tag | Persists |
|-------|-----|----------|
| User | `opencode_user_{sha256(git email)}` | All projects |
| Project | `opencode_project_{sha256(directory)}` | This project |

## Configuration

Create `~/.config/opencode/supermemory.jsonc`:

```jsonc
{
  // API key (can also use SUPERMEMORY_API_KEY env var)
  "apiKey": "sm_...",
  
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
  
  // Prefix for container tags
  "containerTagPrefix": "opencode"
}
```

All fields optional. Env var `SUPERMEMORY_API_KEY` takes precedence over config file.

## Usage with Oh My OpenCode

If you're using [Oh My OpenCode](https://github.com/code-yeongyu/oh-my-opencode), disable its built-in auto-compact hook to let supermemory handle context compaction:

Add to `~/.config/opencode/oh-my-opencode.json`:

```json
{
  "disabled_hooks": ["anthropic-auto-compact"]
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
  "plugin": ["file:///path/to/opencode-supermemory"]
}
```

## Logs

```bash
tail -f ~/.opencode-supermemory.log
```

## License

MIT
