/**
 * OpenCode 2 server plugin entry, resolved as `opencode-supermemory/server`.
 * The root export stays the OpenCode V1 plugin so both generations can load
 * the same package.
 */
import type { Plugin } from "@opencode/plugin";

import { setupV2 } from "./v2/runtime.js";

const plugin: Plugin.Plugin = {
  id: "supermemory",
  setup: (context) => setupV2(context),
};

export default plugin;
