import { type ILinkMessage, MessageItemType } from "./api.js";

/**
 * Longest text sent in one WeChat message. The reference plugin declares
 * `textChunkLimit: 4000` (openclaw-weixin src/channel.ts).
 */
export const WECHAT_TEXT_LIMIT = 4000;

/**
 * Plain text for an inbound message. Only text is supported for now, so other content
 * becomes a short placeholder the Coordinator can understand. Voice uses WeChat's
 * transcript when one is attached.
 */
export function inboundText(msg: ILinkMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    switch (item.type) {
      case MessageItemType.TEXT:
        if (item.text_item?.text) parts.push(item.text_item.text);
        break;
      case MessageItemType.VOICE:
        parts.push(item.voice_item?.text?.trim() || "[voice message]");
        break;
      case MessageItemType.IMAGE:
        parts.push("[image]");
        break;
      case MessageItemType.FILE:
        parts.push(item.file_item?.file_name ? `[file: ${item.file_item.file_name}]` : "[file]");
        break;
      case MessageItemType.VIDEO:
        parts.push("[video]");
        break;
    }
  }
  return parts.length > 0 ? parts.join("\n") : "[unsupported message]";
}

/**
 * Split text into pieces of at most `limit` UTF-16 units, preferring paragraph breaks, then
 * line breaks, then spaces, and never splitting a surrogate pair. Whitespace at a break is
 * dropped.
 */
export function chunkText(text: string, limit = WECHAT_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const floor = Math.floor(limit / 2);
    let cut = -1;
    for (const sep of ["\n\n", "\n", " "]) {
      const at = window.lastIndexOf(sep);
      if (at >= floor) {
        cut = at;
        break;
      }
    }
    if (cut < 0) {
      cut = limit;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
