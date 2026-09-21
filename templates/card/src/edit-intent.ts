import type { NormalizedMessage } from '@larksuite/channel';

/** 用户明确在改已有卡片，而不是从零做一张新的。 */
const EDIT_PATTERNS: RegExp[] = [
  /修改/,
  /改(一?下|成)/,
  /换成/,
  /调整/,
  /更新一?下/,
  /(这|那|上[面边]|刚才的?)(的)?(一?张)?卡(片)?/,
  /把.{0,24}(改|换|调)/,
  /润色/,
  /修一?下/,
  /(删掉|去掉|加一行|加一列|加个按钮)/,
];

export function looksLikeEditCardRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return EDIT_PATTERNS.some((re) => re.test(t));
}

/** 本轮消息本身就是一张卡或合并转发（用户转发卡片后再附一句）。 */
export function isForwardedCardMessage(msg: NormalizedMessage): boolean {
  const t = msg.rawContentType;
  if (t === 'interactive' || t === 'merge_forward') return true;
  return /<forwarded_messages/.test(msg.content);
}

export function shouldLoadLatestCard(msg: NormalizedMessage, text: string): boolean {
  if (msg.replyToMessageId) return true;
  if (isForwardedCardMessage(msg)) return true;
  return looksLikeEditCardRequest(text);
}
