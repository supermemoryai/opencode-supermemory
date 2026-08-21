import { Plugin } from "@opencode-ai/plugin";

import { setupV2 } from "./runtime.js";

export default Plugin.define({
  id: "supermemory.opencode",
  setup: setupV2,
});

export { setupV2 } from "./runtime.js";
