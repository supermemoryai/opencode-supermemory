/**
 * OpenCode 2 TUI companion. OpenCode resolves `opencode-supermemory/tui`
 * automatically next to the server entry and runs it inside the terminal UI.
 * It only renders activity notices emitted by the server plugin as toasts.
 */
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui";

type Context = TuiPlugin.Context;
type Definition = TuiPlugin.Definition;

import {
  isSupermemoryActivityEvent,
  SUPERMEMORY_ACTIVITY_EVENT,
} from "./rpc.js";

const plugin: Definition = {
  id: "supermemory.tui",
  setup(context: Context) {
    const stop = context.data.listen(({ details }) => {
      if (details.type !== SUPERMEMORY_ACTIVITY_EVENT) return;
      const data = (details as { data?: unknown }).data;
      if (!isSupermemoryActivityEvent(data)) return;
      context.ui.toast.show({
        title: data.title,
        message: data.message,
        variant: data.variant,
        duration: data.duration,
      });
    });
    return () => stop();
  },
};

export default plugin;
