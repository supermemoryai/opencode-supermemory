export const USER_ENTITY_CONTEXT = `Developer coding session transcript for a persistent user profile.

EXTRACT:
- User preferences: preferred languages, frameworks, libraries, editors, workflows, and communication style
- Stable habits: testing style, code review expectations, formatting preferences, privacy preferences
- Repeated personal decisions: tools the user consistently chooses or avoids
- Long-lived learnings: concepts the user learned or wants remembered across projects

SKIP:
- One-off assistant suggestions the user did not accept
- Low-level implementation details that only matter inside the current repository`;

export const PROJECT_ENTITY_CONTEXT = `Project/codebase knowledge from OpenCode coding sessions.

EXTRACT:
- Architecture: repo structure, services, modules, data flow, and integration boundaries
- Conventions: naming, component patterns, API patterns, testing practices, and style rules
- Decisions: chosen approaches, tradeoffs, migrations, and rejected alternatives
- Setup: commands, environment requirements, deployment notes, and debugging workflows
- Implementation lessons: bugs fixed, root causes, and reusable project-specific context

SKIP:
- Verbatim assistant explanations unless they became an accepted project decision
- Transient command output with no lasting project value`;
