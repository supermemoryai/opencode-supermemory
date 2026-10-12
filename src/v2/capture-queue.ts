import { createHash } from "node:crypto";

import { formatConversationContent, MAX_CONVERSATION_CHARS } from "../services/conversation.js";
import type { CaptureGroup, CapturePiece } from "./capture-plan.js";

export interface PendingCaptureGroup extends CaptureGroup {
  id: string;
  reason: "cadence" | "session_end";
  pieceIds: string[];
}

export interface CaptureQueue {
  version: 1;
  scope: string;
  account: string;
  sessionID: string;
  deleted: boolean;
  groups: PendingCaptureGroup[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function acknowledgement(value: unknown): value is string {
  return typeof value === "string" && /^opencode:capture:[a-f0-9]{64}:[a-f0-9]{64}$/.test(value);
}

export function parseCaptureAcknowledgements(
  value: unknown,
  scope: string,
  account: string,
  version: 1 | 2,
): { captureIds: string[]; turnIds: string[] } | undefined {
  if (value === undefined) return;
  const keys = version === 2 ? ["version", "scope", "account", "captureIds", "turnIds"] : ["version", "scope", "captureIds", "turnIds"];
  if (!object(value) || value.version !== version || value.scope !== scope ||
      (version === 2 && value.account !== account) ||
      !Array.isArray(value.captureIds) || !Array.isArray(value.turnIds) ||
      !value.captureIds.every((id) => typeof id === "string" && /^opencode:(capture|compaction):[a-f0-9]{64}:[a-f0-9]{64}$/.test(id)) ||
      !value.turnIds.every(digest) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("Invalid or incompatible capture acknowledgements; originals retained");
  }
  return value as unknown as { captureIds: string[]; turnIds: string[] };
}

export function queueCaptureGroup(group: CaptureGroup, reason: PendingCaptureGroup["reason"]): PendingCaptureGroup {
  const pieceIds = group.pieces.map((piece) => piece.acknowledgedId);
  return { ...group, reason, pieceIds, id: sha256(JSON.stringify([group.turnFingerprints, pieceIds])) };
}

export function parseCaptureQueue(
  value: unknown,
  scope: string,
  account: string,
  sessionID: string,
  acknowledged: ReadonlySet<string>,
): CaptureQueue {
  const invalid = () => { throw new Error("Invalid or incompatible pending capture queue; originals retained"); };
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(sessionID)) return invalid();
  if (!object(value) || value.version !== 1 || value.scope !== scope ||
      value.account !== account || value.sessionID !== sessionID ||
      typeof value.deleted !== "boolean" || !Array.isArray(value.groups) ||
      Object.keys(value).some((key) => !["version", "scope", "account", "sessionID", "deleted", "groups"].includes(key))) return invalid();
  const ids = new Set<string>();
  for (const group of value.groups) {
    if (!object(group) || !digest(group.id) || ids.has(group.id) ||
        !["cadence", "session_end"].includes(String(group.reason)) ||
        !Array.isArray(group.turnFingerprints) || group.turnFingerprints.length === 0 ||
        !group.turnFingerprints.every(digest) || !Array.isArray(group.pieceIds) || group.pieceIds.length === 0 ||
        !group.pieceIds.every(acknowledgement) || new Set(group.pieceIds).size !== group.pieceIds.length ||
        !Array.isArray(group.pieces) ||
        group.id !== sha256(JSON.stringify([group.turnFingerprints, group.pieceIds])) ||
        Object.keys(group).some((key) => !["id", "reason", "turnFingerprints", "pieceIds", "pieces"].includes(key))) return invalid();
    ids.add(group.id);
    const payloadIds = new Set<string>();
    for (const piece of group.pieces) {
      if (!object(piece) || typeof piece.id !== "string" || !/^opencode:capture:[a-f0-9]{64}$/.test(piece.id) ||
          !acknowledgement(piece.acknowledgedId) || !group.pieceIds.includes(piece.acknowledgedId) || payloadIds.has(piece.acknowledgedId) ||
          typeof piece.conversationId !== "string" || !piece.conversationId.startsWith(`${sessionID}:`) ||
          typeof piece.preserveWhitespace !== "boolean" ||
          !Number.isSafeInteger(piece.startTurn) || Number(piece.startTurn) < 1 ||
          !Number.isSafeInteger(piece.endTurn) || Number(piece.endTurn) < Number(piece.startTurn) ||
          !Array.isArray(piece.messages) || piece.messages.length === 0 ||
          !piece.messages.every((message) => object(message) &&
            ["user", "assistant", "system", "tool"].includes(String(message.role)) && typeof message.content === "string" &&
            Object.keys(message).every((key) => key === "role" || key === "content")) ||
          piece.acknowledgedId !== `${piece.id}:${sha256(JSON.stringify(piece.messages))}` ||
          !object(piece.metadata) || Object.entries(piece.metadata).some(([key, item]) => {
            if (key === "captureFragment") return item !== true;
            if (key === "captureTurnFingerprint") return !digest(item);
            if (key === "captureTurnId") return typeof item !== "string" || item.length === 0 || item.length > 1024;
            return !["captureMessageIndex", "captureChunkIndex", "captureChunkStart", "captureChunkEnd"].includes(key) ||
              !Number.isSafeInteger(item) || Number(item) < 0;
          }) ||
          Object.keys(piece).some((key) => !["id", "acknowledgedId", "conversationId", "messages", "startTurn", "endTurn", "preserveWhitespace", "metadata"].includes(key))) return invalid();
      const typed = piece as unknown as CapturePiece;
      const metadata = typed.metadata;
      if (metadata.captureFragment === true) {
        const keys = ["captureFragment", "captureTurnId", "captureTurnFingerprint", "captureMessageIndex", "captureChunkIndex", "captureChunkStart", "captureChunkEnd"];
        if (keys.some((key) => !(key in metadata)) || Object.keys(metadata).length !== keys.length ||
            !/^[A-Za-z0-9_-]{1,1024}$/.test(String(metadata.captureTurnId)) ||
            !group.turnFingerprints.includes(String(metadata.captureTurnFingerprint)) ||
            typed.messages.length !== 1 || !typed.preserveWhitespace ||
            typed.conversationId !== `${sessionID}:${metadata.captureTurnId}:m${metadata.captureMessageIndex}:c${metadata.captureChunkIndex}` ||
            Number(metadata.captureChunkEnd) - Number(metadata.captureChunkStart) !== typed.messages[0]!.content.length ||
            typed.id !== `opencode:capture:${sha256(JSON.stringify([sessionID, metadata.captureTurnId, metadata.captureTurnFingerprint, metadata.captureMessageIndex, metadata.captureChunkIndex]))}`) return invalid();
      } else if (Object.keys(metadata).length !== 0 || typed.preserveWhitespace ||
                 !new RegExp(`^${sessionID}:[1-9][0-9]*-[1-9][0-9]*$`).test(typed.conversationId)) return invalid();
      if (formatConversationContent(typed.conversationId, typed.messages, typed.preserveWhitespace).length > MAX_CONVERSATION_CHARS) return invalid();
      payloadIds.add(piece.acknowledgedId);
    }
    if (!group.pieceIds.every((id) => acknowledged.has(id) || payloadIds.has(id))) return invalid();
  }
  return JSON.parse(JSON.stringify(value)) as CaptureQueue;
}
