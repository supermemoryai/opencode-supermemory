# Changelog

## 2.0.16

- Use the official pinned Supermemory 5.0.1 SDK for hosted content, preserving namespace strings, batch IDs, metadata, search defaults, capture cadence, and permissions.
- Keep the bundled official 4.0.0 SDK for custom servers by default, with explicit `apiVersion` / `SUPERMEMORY_API_VERSION` selection and no cross-version or hosted fallback.
- Normalize v5 profiles, search timestamps and document-list envelopes; require confirmed write acceptance and exact deletion outcomes.
- Retain the legacy settings and account boundaries instead of replacing organization context or dropping existing configuration.
- Rebuild all plugin/CLI entrypoints with both SDKs and their license texts; use the checked-in dependency lock for release builds.
