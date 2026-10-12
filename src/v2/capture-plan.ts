import { createHash } from "node:crypto";

import { getCaptureId, type CaptureBatch, type CaptureTurn } from "../services/capture.js";
import {
  conversationMessageText,
  formatConversationContent,
  MAX_CONVERSATION_CHARS,
} from "../services/conversation.js";
import type { ConversationMessage } from "../types/index.js";

export interface CapturePiece {
  id: string;
  acknowledgedId: string;
  conversationId: string;
  messages: ConversationMessage[];
  startTurn: number;
  endTurn: number;
  preserveWhitespace: boolean;
  metadata: Record<string, string | number | boolean>;
}

export interface CaptureGroup {
  turnFingerprints: string[];
  pieces: CapturePiece[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function wholePiece(sessionID: string, batch: CaptureBatch): CapturePiece {
  const messages = batch.turns.flatMap((turn) => turn.messages.map((message) => ({
    role: message.role, content: conversationMessageText(message),
  })));
  const id = getCaptureId(sessionID, batch);
  return {
    id,
    acknowledgedId: `${id}:${sha256(JSON.stringify(messages))}`,
    conversationId: `${sessionID}:${batch.startTurn}-${batch.endTurn}`,
    messages,
    startTurn: batch.startTurn,
    endTurn: batch.endTurn,
    preserveWhitespace: false,
    metadata: {},
  };
}

export function planCapture(
  sessionID: string,
  batch: CaptureBatch,
  positions?: readonly number[],
): CaptureGroup[] {
  const whole = wholePiece(sessionID, batch);
  if (formatConversationContent(whole.conversationId, whole.messages).length <= MAX_CONVERSATION_CHARS) {
    return [{ turnFingerprints: batch.turns.map((turn) => sha256(JSON.stringify(turn))), pieces: [whole] }];
  }

  return batch.turns.map((turn, turnIndex) => {
    const position = positions?.[turnIndex] ?? batch.startTurn + turnIndex;
    const single = wholePiece(sessionID, { startTurn: position, endTurn: position, turns: [turn] });
    if (formatConversationContent(single.conversationId, single.messages).length <= MAX_CONVERSATION_CHARS) {
      return { turnFingerprints: [sha256(JSON.stringify(turn))], pieces: [single] };
    }

    const fingerprint = sha256(JSON.stringify(turn));
    const pieces: CapturePiece[] = [];
    for (const [messageIndex, message] of turn.messages.entries()) {
      const text = conversationMessageText(message);
      let start = 0;
      let chunkIndex = 0;
      do {
        const conversationId = `${sessionID}:${turn.id}:m${messageIndex}:c${chunkIndex}`;
        const empty = { role: message.role, content: "" };
        const budget = MAX_CONVERSATION_CHARS - formatConversationContent(conversationId, [empty], true).length - 1;
        if (budget < 2) throw new Error("Capture identity exceeds the fragment budget");
        let end = Math.min(start + budget, text.length);
        if (end < text.length &&
            text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff &&
            text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end -= 1;
        const messages = [{ role: message.role, content: text.slice(start, end) }];
        const id = `opencode:capture:${sha256(JSON.stringify([sessionID, turn.id, fingerprint, messageIndex, chunkIndex]))}`;
        pieces.push({
          id,
          acknowledgedId: `${id}:${sha256(JSON.stringify(messages))}`,
          conversationId,
          messages,
          startTurn: position,
          endTurn: position,
          preserveWhitespace: true,
          metadata: {
            captureFragment: true,
            captureTurnId: turn.id,
            captureTurnFingerprint: fingerprint,
            captureMessageIndex: messageIndex,
            captureChunkIndex: chunkIndex,
            captureChunkStart: start,
            captureChunkEnd: end,
          },
        });
        start = end;
        chunkIndex += 1;
      } while (start < text.length);
    }
    return { turnFingerprints: [fingerprint], pieces };
  });
}
