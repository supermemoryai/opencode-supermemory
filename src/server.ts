/**
 * Server plugin entry, resolved as `opencode-supermemory/server` by both
 * OpenCode generations. OpenCode 2 reads `id` and `setup()`. OpenCode V1
 * (1.16 and later) also resolves this export and calls `server()`, so the
 * default export carries both implementations.
 */
import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode/plugin";

import { SupermemoryPlugin } from "./index.js";
import { setupV2 } from "./v2/runtime.js";

const plugin: Plugin.Plugin & { server: V1Plugin } = {
  id: "supermemory",
  setup: (context) => setupV2(context),
  server: (input, options) => SupermemoryPlugin(input, options),
};

export default plugin;
