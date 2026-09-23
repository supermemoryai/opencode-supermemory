/** @jsxImportSource @opentui/solid */
/**
 * TUI plugin for both OpenCode generations, resolved as `opencode-supermemory/tui`.
 *
 * OpenCode V1 calls `tui()` (registered through `~/.config/opencode/tui.jsonc`);
 * OpenCode 2 calls `setup()` (loaded automatically next to the server plugin).
 * Both keep a persistent `◪ supermemory` footer: blue while a session is
 * running, otherwise the latest recall or save activity. OpenCode 2 also
 * renders the server's activity notices as toasts here.
 */
import type {
  TuiPlugin as V1TuiPlugin,
  TuiPluginApi as V1TuiPluginApi,
} from "@opencode-ai/plugin/tui";
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui";
import type { RGBA } from "@opentui/core";
import { createSignal } from "solid-js";

import {
  isSupermemoryActivityEvent,
  SUPERMEMORY_ACTIVITY_EVENT,
} from "./rpc.js";
import {
  activityLabel,
  DEFAULT_STATUS_ACTIVITY,
  getRecallActivity,
  recallLabel,
  STATUS_PREFIX,
  statusText,
} from "./tui-status.js";

type Color = string | RGBA;
const FALLBACK_RUNNING: Color = "#60a5fa";
const FALLBACK_IDLE: Color = "#a78bfa";

function createStatus() {
  const busy = new Set<string>();
  const [running, setRunning] = createSignal(false);
  const [activity, setActivity] = createSignal(DEFAULT_STATUS_ACTIVITY);
  return {
    running,
    activity,
    setActivity,
    markBusy(sessionID: string | undefined) {
      if (sessionID) busy.add(sessionID);
      setRunning(busy.size > 0);
    },
    markIdle(sessionID: string | undefined) {
      if (sessionID) busy.delete(sessionID);
      setRunning(busy.size > 0);
    },
  };
}

// ---------------------------------------------------------------------------
// OpenCode V1
// ---------------------------------------------------------------------------

const tui: V1TuiPlugin = async (api: V1TuiPluginApi) => {
  const status = createStatus();

  api.event.on("session.status", (event) => {
    const { sessionID, status: state } = event.properties;
    if (state.type === "busy" || state.type === "retry") status.markBusy(sessionID);
    else status.markIdle(sessionID);
  });
  api.event.on("session.idle", (event) => {
    status.markIdle(event.properties.sessionID);
  });
  api.event.on("message.part.updated", (event) => {
    const recalled = getRecallActivity(event.properties.part);
    if (recalled) status.setActivity(recallLabel(recalled));
  });
  api.event.on("tui.toast.show", (event) => {
    const message = event.properties.message;
    if (message.startsWith(STATUS_PREFIX)) status.setActivity(activityLabel(message));
  });

  api.slots.register({
    slots: {
      app_bottom: () => (
        <box paddingLeft={1} flexDirection="row">
          <text fg={status.running() ? api.theme.current.info : api.theme.current.success}>
            {statusText(status.running(), status.activity())}
          </text>
        </box>
      ),
    },
  });
};

// ---------------------------------------------------------------------------
// OpenCode 2
// ---------------------------------------------------------------------------

type ThemeLike = {
  text?: {
    base?: Color;
    muted?: Color;
    action?: { primary?: { base?: Color } };
    feedback?: {
      success?: { base?: Color };
      info?: { base?: Color };
    };
  };
};

function v2StatusColor(theme: unknown, running: boolean): Color {
  const text = (theme as ThemeLike | undefined)?.text;
  if (running) {
    return text?.feedback?.info?.base ?? text?.action?.primary?.base ?? FALLBACK_RUNNING;
  }
  return text?.feedback?.success?.base ?? text?.muted ?? FALLBACK_IDLE;
}

function eventSessionID(event: unknown): string | undefined {
  const data = (event as { data?: { sessionID?: unknown } }).data;
  return typeof data?.sessionID === "string" ? data.sessionID : undefined;
}

const setup: TuiPlugin.Definition["setup"] = (context) => {
  const status = createStatus();
  const stops: Array<() => void> = [];

  stops.push(
    context.data.on("session.execution.started", (event) => {
      status.markBusy(eventSessionID(event));
    }),
  );
  for (const type of [
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.idle",
    "session.deleted",
  ] as const) {
    stops.push(
      context.data.on(type, (event) => {
        status.markIdle(eventSessionID(event));
      }),
    );
  }

  stops.push(
    context.data.listen(({ details }) => {
      if (details.type !== SUPERMEMORY_ACTIVITY_EVENT) return;
      const data = (details as { data?: unknown }).data;
      if (!isSupermemoryActivityEvent(data)) return;
      status.setActivity(activityLabel(data.message));
      context.ui.toast.show({
        title: data.title,
        message: data.message,
        variant: data.variant,
        duration: data.duration,
      });
    }),
  );

  const render = () => (
    <text fg={v2StatusColor(context.theme, status.running())}>
      {statusText(status.running(), status.activity())}
    </text>
  );
  stops.push(context.ui.slot({ append: "prompt.footer.status", render }));
  stops.push(context.ui.slot({ append: "home.footer.status", render }));

  return () => {
    for (const stop of stops.splice(0)) stop();
  };
};

const plugin: TuiPlugin.Definition & { tui: V1TuiPlugin } = {
  id: "supermemory.tui",
  tui,
  setup,
};

export default plugin;
