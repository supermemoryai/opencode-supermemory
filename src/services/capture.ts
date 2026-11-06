import type { Part } from "@opencode-ai/sdk";

import { supermemoryClient } from "./client.js";
import { AGENT_ENTITY_CONTEXT } from "./entity-context.js";
import { log } from "./logger.js";
import type { ResolvedTags } from "./tags.js";
import {
  captureSession,
  SESSION_CAPTURE_TIMEOUT_MS,
  sessionMetadata,
  type SessionWriter,
} from "./session.js";

interface CaptureMessageInfo {
  id: string;
  role: string;
  sessionID?: string;
  finish?: string;
  summary?: unknown;
}

export interface SessionMessage {
  info: CaptureMessageInfo;
  parts?: Part[];
}

interface CaptureContext {
  directory: string;
  client: {
    session: {
      messages: (params: {
        path: { id: string };
        query: { directory: string };
      }) => Promise<
        { data?: SessionMessage[]; error?: unknown } | SessionMessage[]
      >;
    };
  };
}

export interface CaptureOptions {
  writer?: SessionWriter;
  onSaved?: () => void;
}

export function createCaptureHook(
  ctx: CaptureContext,
  tags: ResolvedTags,
  options?: CaptureOptions,
) {
  const writer = options?.writer ?? supermemoryClient;
  const activeSessions = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();

  async function readMessages(sessionID: string): Promise<SessionMessage[]> {
    const response = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory },
    });
    if (!Array.isArray(response) && !response.data) {
      throw new Error(`Unable to read OpenCode session ${sessionID}`);
    }
    return Array.isArray(response) ? response : (response.data ?? []);
  }

  async function capture(sessionID: string): Promise<boolean> {
    let messages: SessionMessage[];
    try {
      messages = await readMessages(sessionID);
    } catch (error) {
      log("[capture] failed to read session transcript", {
        sessionID,
        error: String(error),
      });
      return false;
    }
    return captureSession({
      writer,
      namespace: tags.canonical,
      sessionId: sessionID,
      messages,
      metadata: sessionMetadata(tags.projectName, tags.projectId),
      supportingContext: AGENT_ENTITY_CONTEXT,
      timeoutMs: SESSION_CAPTURE_TIMEOUT_MS,
      onSaved: options?.onSaved,
    });
  }

  async function runExclusive(
    sessionID: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = inFlight.get(sessionID) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    inFlight.set(sessionID, next);
    try {
      await next;
    } finally {
      if (inFlight.get(sessionID) === next) {
        inFlight.delete(sessionID);
      }
    }
  }

  return {
    async event({ event }: { event: { type: string; properties?: unknown } }) {
      const props = event.properties as Record<string, unknown> | undefined;

      if (event.type === "message.updated") {
        const info = props?.info as CaptureMessageInfo | undefined;
        if (info?.sessionID) activeSessions.add(info.sessionID);
        return;
      }

      if (event.type === "session.idle") {
        const sessionID = props?.sessionID as string | undefined;
        if (!sessionID) return;
        activeSessions.add(sessionID);
        await runExclusive(sessionID, async () => {
          await capture(sessionID);
        });
        return;
      }

      if (event.type === "session.deleted") {
        const sessionID = (props?.info as { id?: string } | undefined)?.id;
        if (!sessionID) return;
        activeSessions.add(sessionID);
        await runExclusive(sessionID, async () => {
          if (await capture(sessionID)) activeSessions.delete(sessionID);
        });
        return;
      }

      if (event.type === "server.instance.disposed") {
        await Promise.all(
          [...activeSessions].map((sessionID) =>
            runExclusive(sessionID, async () => {
              if (await capture(sessionID)) activeSessions.delete(sessionID);
            }),
          ),
        );
      }
    },
  };
}
