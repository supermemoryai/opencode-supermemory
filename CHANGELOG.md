# Changelog

## 2.2.0

- Skip automatic recall, capture and compaction memory for subagent sessions (any session with a `parentID`) and, on OpenCode V1, for `opencode run` / `opencode github run`. Opt back in with `captureSubagents` / `captureHeadless` or `SUPERMEMORY_CAPTURE_SUBAGENTS=true` / `SUPERMEMORY_CAPTURE_HEADLESS=true`.
- Treat Conductor and Vibe Kanban sessions as interactive; `captureOrchestrated: false` skips them.
- Replace an opening prompt of 200+ characters already captured from this machine for the same container in the last 24 hours with a one-line marker (`dedupeOpeningPrompt`), and re-serve the last successful recall for exact query repeats within 10 minutes instead of searching again (`dedupeRecallQueries`).
- `SUPERMEMORY_CAPTURE_*` / `SUPERMEMORY_DEDUPE_*` accept `true/1/yes/on` and `false/0/no/off`; OpenCode V1 headless detection skips the values of value-taking flags (`--port 4096 run` is headless, `--prompt run` is not); the parent-session lookup fails open after 2 seconds.

## 2.1.2

- Keep `login` waiting for the callback when no browser can be opened, and print the URL to open instead of failing (#72).
- On WSL, open the login URL in the Windows browser through `wslview` or PowerShell before falling back to `xdg-open`.

## 2.0.16

- Use the official pinned Supermemory 5.0.1 SDK for hosted content, preserving namespace strings, batch IDs, metadata, search defaults, capture cadence, and permissions.
- Keep the bundled official 4.0.0 SDK for custom servers by default, with explicit `apiVersion` / `SUPERMEMORY_API_VERSION` selection and no cross-version or hosted fallback.
- Normalize v5 profiles, search timestamps and document-list envelopes; require confirmed write acceptance and exact deletion outcomes.
- Retain the legacy settings and account boundaries instead of replacing organization context or dropping existing configuration.
- Rebuild all plugin/CLI entrypoints with both SDKs and their license texts; use the checked-in dependency lock for release builds.
