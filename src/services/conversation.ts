import type { ConversationMessage } from "../types/index.js";

export const MAX_CONVERSATION_CHARS = 100_000;

export function conversationMessageText(message: ConversationMessage): string {
  return (typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.type === "text"
      ? part.text
      : `[image] ${part.imageUrl.url}`).join("\n")).trim();
}

export function formatConversationMessage(
  message: ConversationMessage,
  preserveWhitespace = false,
): string {
  const content = preserveWhitespace && typeof message.content === "string"
    ? message.content
    : conversationMessageText(message);
  return content.length === 0 ? `[${message.role}]` : `[${message.role}] ${content}`;
}

export function formatConversationContent(
  conversationId: string,
  messages: ConversationMessage[],
  preserveWhitespace = false,
): string {
  return `[Conversation ${conversationId}]\n${messages.map((message, index) =>
    `${index + 1}. ${formatConversationMessage(message, preserveWhitespace)}`).join("\n")}`;
}
