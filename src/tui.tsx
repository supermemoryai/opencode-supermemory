/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import { createSignal } from "solid-js";

const DEFAULT_ACTIVITY = "ready";

interface RecallActivity {
  count: number;
  tokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function getRecallActivity(part: unknown): RecallActivity | null {
  const value = asRecord(part);
  if (!value || value.type !== "text") return null;

  const metadata = asRecord(value.metadata);
  const supermemory = asRecord(metadata?.supermemory);
  if (supermemory?.activity === "recalled") {
    const count = supermemory.count;
    const tokens = supermemory.tokens;
    if (typeof count === "number" && typeof tokens === "number") {
      return { count, tokens };
    }
  }

  const text = typeof value.text === "string" ? value.text : "";
  if (!text.includes("<supermemory-context>")) return null;
  const count = text.split("\n").filter((line) => line.startsWith("- ◪ ")).length;
  return count > 0
    ? { count, tokens: Math.round(text.length / 4) }
    : null;
}

function recallLabel(activity: RecallActivity): string {
  return `recalled ${activity.count} ${activity.count === 1 ? "memory" : "memories"} (${activity.tokens} tok)`;
}

const tui: TuiPlugin = async (api) => {
  const busySessions = new Set<string>();
  const [running, setRunning] = createSignal(false);
  const [activity, setActivity] = createSignal(DEFAULT_ACTIVITY);

  api.event.on("session.status", (event) => {
    const { sessionID, status } = event.properties;
    if (status.type === "busy" || status.type === "retry") {
      busySessions.add(sessionID);
    } else {
      busySessions.delete(sessionID);
    }
    setRunning(busySessions.size > 0);
  });

  api.event.on("session.idle", (event) => {
    busySessions.delete(event.properties.sessionID);
    setRunning(busySessions.size > 0);
  });

  api.event.on("message.part.updated", (event) => {
    const recalled = getRecallActivity(event.properties.part);
    if (recalled) setActivity(recallLabel(recalled));
  });

  api.event.on("tui.toast.show", (event) => {
    const message = event.properties.message;
    if (!message.startsWith("◪ supermemory · ")) return;
    setActivity(message.slice("◪ supermemory · ".length));
  });

  api.slots.register({
    slots: {
      app_bottom: () => (
        <box paddingLeft={1} flexDirection="row">
          <text fg={running() ? api.theme.current.info : api.theme.current.success}>
            {`◪ supermemory · ${running() ? "running" : activity()}`}
          </text>
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
