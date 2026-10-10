/**
 * OpenCode 2 RPC contract shared by the server plugin (`opencode-supermemory/server`)
 * and the TUI companion (`opencode-supermemory/tui`). The server emits activity
 * notices here and the TUI renders them as toasts, so notices never enter model
 * context. Importable as `opencode-supermemory/rpc` without loading either side.
 */
import type { Rpc } from "@opencode/plugin/rpc";

export const SUPERMEMORY_RPC_ID = "supermemory";

/** Wire type of the activity event, as seen on the OpenCode event stream. */
export const SUPERMEMORY_ACTIVITY_EVENT = `rpc.${SUPERMEMORY_RPC_ID}.activity`;

export type SupermemoryActivityVariant = "info" | "success" | "warning" | "error";

export interface SupermemoryActivityEvent {
  kind: string;
  title: string;
  message: string;
  variant: SupermemoryActivityVariant;
  duration: number;
}

export const SUPERMEMORY_RPC = {
  id: SUPERMEMORY_RPC_ID,
  methods: {},
  events: {
    activity: {
      schema: {
        type: "object",
        properties: {
          kind: { type: "string" },
          title: { type: "string" },
          message: { type: "string" },
          variant: {
            type: "string",
            enum: ["info", "success", "warning", "error"],
          },
          duration: { type: "number" },
        },
        required: ["kind", "title", "message", "variant", "duration"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition;

export function isSupermemoryActivityEvent(
  value: unknown,
): value is SupermemoryActivityEvent {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.message === "string" &&
    typeof data.title === "string" &&
    typeof data.variant === "string" &&
    typeof data.duration === "number"
  );
}
