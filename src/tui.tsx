/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";

const SUPERMEMORY_PURPLE = "#a78bfa";

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      app_bottom: () => (
        <box paddingLeft={2} paddingBottom={3} flexDirection="row">
          <text fg={SUPERMEMORY_PURPLE}>◪ supermemory</text>
        </box>
      ),
    },
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id: "supermemory.status",
  tui,
};

export default plugin;
