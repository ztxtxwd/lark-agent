import type lark from '@larksuiteoapi/node-sdk';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { LarkChannel } from '@larksuite/channel';
import { config } from './config.js';
import { extractCardSummary } from './parent-card.js';

export interface HistoryImageRef {
  messageId: string;
  fileKey: string;
}

export interface HistoryLine {
  role: 'user' | 'bot';
  text: string;
  messageId?: string;
  /** 卡片消息：历史里只有标题占位，完整内容需经 get_message_detail 获取 */
  kind?: 'card';
  /** 原生系统消息（如「开启新会话」分隔条）：渲染为分界线而非对话行 */
  systemDivider?: boolean;
  /** 消息附带的图片（单独以 image 格式传给模型） */
  imageRefs?: HistoryImageRef[];
}

export interface BotCardInHistory {
  messageId: string;
  summary: string;
}

type MessageItem = {
  message_id?: string;
  msg_type?: string;
  body?: { content?: string };
  mentions?: Array<{ key?: string; name?: string; id?: string; id_type?: string }>;
  sender?: { id?: string; id_type?: string; sender_type?: string };
  create_time?: string;
  deleted?: boolean;
};

const HISTORY_PAGE_SIZE = Math.min(50, config.historyLimit);

function describeType(msgType: string): string {
  switch (msgType) {
    case 'image':
      return '[图片]';
    case 'file':
      return '[文件]';
    case 'audio':
      return '[语音]';
    case 'media':
    case 'video':
      return '[视频]';
    case 'sticker':
      return '[表情]';
    default:
      return `[${msgType}]`;
  }
}

export function parseTextContent(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

/** 从 post 富文本里提取正文与内嵌图片 key。 */
export function parsePostContent(content: string | undefined): string {
  return parsePostParts(content).text;
}

function parsePostParts(content: string | undefined): { text: string; imageKeys: string[] } {
  if (!content) return { text: '', imageKeys: [] };
  try {
    const parsed = JSON.parse(content) as Record<string, { content?: unknown[][] } | undefined>;
    const locale = parsed.zh_cn ?? parsed.en_us ?? Object.values(parsed)[0];
    const lines: string[] = [];
    const imageKeys: string[] = [];
    for (const paragraph of locale?.content ?? []) {
      for (const node of paragraph ?? []) {
        const tag = (node as { tag?: string }).tag;
        if (tag === 'text' || tag === 'a') {
          lines.push(String((node as { text?: string }).text ?? ''));
        } else if (tag === 'at') {
          lines.push(`@${(node as { user_name?: string }).user_name ?? ''}`);
        } else if (tag === 'img') {
          lines.push('[图片]');
          const key = (node as { image_key?: string }).image_key;
          if (key) imageKeys.push(key);
        }
      }
      lines.push('\n');
    }
    return { text: lines.join(''), imageKeys };
  } catch {
    return { text: '', imageKeys: [] };
  }
}

function extractImageKey(content: string | undefined): string | undefined {
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(content) as { image_key?: unknown };
    return typeof parsed.image_key === 'string' ? parsed.image_key : undefined;
  } catch {
    return undefined;
  }
}

function imageRefsFor(messageId: string | undefined, fileKeys: string[]): HistoryImageRef[] {
  if (!messageId) return [];
  return fileKeys.map((fileKey) => ({ messageId, fileKey }));
}

function hydrateMentions(text: string, item: MessageItem): string {
  let out = text;
  for (const m of item.mentions ?? []) {
    if (m.key && m.name) out = out.replaceAll(m.key, `@${m.name}`);
  }
  return out;
}

function cardTitle(content: string | undefined): string {
  if (!content) return '(无标题卡片)';
  try {
    const card = JSON.parse(content) as {
      header?: { title?: { content?: string } };
      schema?: unknown;
      body?: unknown;
    };
    const title = card.header?.title?.content?.trim();
    return title || '(无标题卡片)';
  } catch {
    return '(无标题卡片)';
  }
}

/**
 * 解析原生系统消息（msg_type=system，如「开启新会话」的 divider 文本分隔条）
 * 的文字标签；非 divider 系统消息或解析失败返回空串。
 */
function systemMessageLabel(content: string | undefined): string {
  try {
    const parsed = JSON.parse(content ?? '') as {
      params?: { divider_text?: { text?: unknown; i18n_text?: Record<string, unknown> } };
    };
    const dt = parsed.params?.divider_text;
    const zh = typeof dt?.i18n_text?.zh_CN === 'string' ? dt.i18n_text.zh_CN : undefined;
    return (typeof dt?.text === 'string' && dt.text.trim()) || zh || '';
  } catch {
    return '';
  }
}

function isBotCard(item: MessageItem): boolean {
  return item.sender?.sender_type === 'app' && item.msg_type === 'interactive';
}

function sortByCreateTimeAsc(items: MessageItem[]): MessageItem[] {
  return [...items].sort(
    (a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0),
  );
}

/** 在按时间升序排列的消息里，找机器人最后一次输出卡片的下标。 */
export function findLastBotCardIndex(items: MessageItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (isBotCard(items[i]!)) return i;
  }
  return -1;
}

/** 从按时间升序的消息列表里提取机器人输出的卡片摘要（旧 → 新）。 */
export function extractBotCards(items: MessageItem[]): BotCardInHistory[] {
  const cards: BotCardInHistory[] = [];
  for (const item of items) {
    if (!isBotCard(item) || !item.message_id) continue;
    const summary = extractCardSummary(item.body?.content);
    cards.push({ messageId: item.message_id, summary });
  }
  return cards;
}

/** Map one Lark message item to a compact history line. */
export function toHistoryLine(item: MessageItem, currentMessageId?: string): HistoryLine | undefined {
  if (!item.msg_type || item.deleted === true) return undefined;
  if (currentMessageId && item.message_id === currentMessageId) return undefined;
  const role: 'user' | 'bot' = item.sender?.sender_type === 'app' ? 'bot' : 'user';
  let text: string;
  let imageRefs: HistoryImageRef[] | undefined;
  switch (item.msg_type) {
    case 'text':
      text = hydrateMentions(parseTextContent(item.body?.content), item).trim();
      break;
    case 'post': {
      const post = parsePostParts(item.body?.content);
      text = hydrateMentions(post.text, item).trim();
      imageRefs = imageRefsFor(item.message_id, post.imageKeys);
      break;
    }
    case 'interactive':
      return {
        role,
        text: cardTitle(item.body?.content),
        ...(item.message_id ? { messageId: item.message_id } : {}),
        kind: 'card',
      };
    case 'image': {
      const imageKey = extractImageKey(item.body?.content);
      if (!imageKey) return undefined;
      return {
        role,
        text: '[图片]',
        ...(item.message_id ? { messageId: item.message_id } : {}),
        imageRefs: imageRefsFor(item.message_id, [imageKey]),
      };
    }
    case 'file':
    case 'audio':
    case 'media':
    case 'video': {
      let name = '';
      try {
        const parsed = JSON.parse(item.body?.content ?? '') as { file_name?: unknown };
        if (typeof parsed.file_name === 'string') name = ` ${parsed.file_name}`;
      } catch {
        // keep bare placeholder
      }
      text = `${describeType(item.msg_type)}${name}`;
      break;
    }
    case 'system': {
      const label = systemMessageLabel(item.body?.content);
      if (!label) {
        text = describeType(item.msg_type);
        break;
      }
      return {
        role,
        text: label,
        ...(item.message_id ? { messageId: item.message_id } : {}),
        systemDivider: true,
      };
    }
    default:
      text = describeType(item.msg_type);
  }
  if (!text.trim() && !imageRefs?.length) return undefined;
  return {
    role,
    text: text.trim() || '[图片]',
    ...(item.message_id ? { messageId: item.message_id } : {}),
    ...(imageRefs?.length ? { imageRefs } : {}),
  };
}

/**
 * Fetch recent chat history directly from the Feishu message-list API
 * (`im.v1.message.list`). Requires im:message.p2p_msg:readonly in p2p chats;
 * in group chats the scope im:message.group_msg is needed — on failure this
 * returns an empty list and the turn proceeds without history.
 *
 * 取最近 50 条消息；上下文只保留机器人最后一次输出卡片之后的消息；
 * 同时列出 50 条内所有机器人卡片摘要，供模型判断新建还是修改。
 */
export interface ChatHistoryResult {
  lines: HistoryLine[];
  /** 进入上下文的原始消息（最后一次机器人卡片之后） */
  rawItems: MessageItem[];
  /** 最近 50 条里机器人输出的卡片摘要 */
  botCards: BotCardInHistory[];
  /** 上下文消息里需要以 image 格式传给模型的图片 */
  imageRefs: HistoryImageRef[];
}

/** 当前会话里最新一张互动卡片（不限发送者）。失败返回 undefined。 */
export async function findLatestCardMessageId(
  client: lark.Client,
  chatId: string,
  opts: { beforeMs: number },
): Promise<string | undefined> {
  try {
    const res = await client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        sort_type: 'ByCreateTimeDesc',
        end_time: String(Math.floor(opts.beforeMs / 1000) + 1),
        page_size: HISTORY_PAGE_SIZE,
        card_msg_content_type: 'user_card_content',
      },
    });
    return latestInteractiveId((res.data?.items ?? []) as MessageItem[]);
  } catch (err) {
    console.warn('[history] 查找最近卡片失败', chatId, err);
    return undefined;
  }
}

/** 合并转发的 parent+descendants 里最晚的一张互动卡片。 */
export async function findLatestCardInMessageGet(
  client: lark.Client,
  messageId: string,
): Promise<string | undefined> {
  try {
    const res = await client.im.message.get({
      path: { message_id: messageId },
      params: { card_msg_content_type: 'user_card_content' },
    });
    return latestInteractiveId((res.data?.items ?? []) as MessageItem[]);
  } catch (err) {
    console.warn('[history] 解析转发消息里的卡片失败', messageId, err);
    return undefined;
  }
}

function latestInteractiveId(items: MessageItem[]): string | undefined {
  const chronological = sortByCreateTimeAsc(items);
  for (let i = chronological.length - 1; i >= 0; i--) {
    const item = chronological[i];
    if (!item || item.deleted === true) continue;
    if (item.msg_type === 'interactive' && item.message_id) return item.message_id;
  }
  return undefined;
}

export async function fetchChatHistory(
  client: lark.Client,
  chatId: string,
  opts: {
    beforeMs: number;
    excludeMessageId?: string;
  },
): Promise<ChatHistoryResult> {
  const endSec = Math.floor(opts.beforeMs / 1000);
  const res = await client.im.message.list({
    params: {
      container_id_type: 'chat',
      container_id: chatId,
      sort_type: 'ByCreateTimeDesc',
      end_time: String(endSec),
      page_size: HISTORY_PAGE_SIZE,
      card_msg_content_type: 'user_card_content',
    },
  });

  const rawItems = (res.data?.items ?? []) as MessageItem[];
  // 不依赖 API 返回顺序（实测 ByCreateTimeDesc 仍可能乱序），统一按 create_time 升序。
  const chronological = sortByCreateTimeAsc(rawItems);
  const botCards = extractBotCards(chronological).reverse();

  const lastBotCardIdx = findLastBotCardIndex(chronological);
  const contextItems =
    lastBotCardIdx >= 0 ? chronological.slice(lastBotCardIdx + 1) : chronological;

  const lines: HistoryLine[] = [];
  const imageRefs: HistoryImageRef[] = [];
  for (const item of contextItems) {
    const line = toHistoryLine(item, opts.excludeMessageId);
    if (!line) continue;
    lines.push(line);
    for (const ref of line.imageRefs ?? []) {
      if (!imageRefs.some((r) => r.messageId === ref.messageId && r.fileKey === ref.fileKey)) {
        imageRefs.push(ref);
      }
    }
  }

  return { lines, rawItems: contextItems, botCards, imageRefs };
}

/**
 * Render history lines as a compact prompt block.
 *
 * 每行附带 mid:<message_id>（与卡片一致），方便 get_message_detail 定位附件。
 * 图片在历史文本里以 [图片] 标记，实际像素走 image 通道。
 */
export function renderHistory(lines: HistoryLine[]): string {
  if (lines.length === 0) return '';
  return lines
    .map((l) => {
      if (l.systemDivider) return `───── ${l.text} ─────`;
      const role = l.role === 'user' ? '用户' : '机器人';
      const mid = l.messageId ? ` mid:${l.messageId}` : '';
      if (l.kind === 'card') {
        return `${role}: [卡片${mid}] ${l.text}`;
      }
      return `${role}:${mid} ${l.text}`;
    })
    .join('\n');
}

/** 列出最近消息里机器人输出的卡片 ID 与 config.summary.content（新 → 旧）。 */
export function renderBotCardsList(cards: BotCardInHistory[]): string {
  if (cards.length === 0) return '';
  return cards
    .map((c) => {
      const summary = c.summary.trim();
      return summary ? `- ${c.messageId}: ${summary}` : `- ${c.messageId}: (无摘要)`;
    })
    .join('\n');
}

function guessMimeType(contentType: string | undefined): string {
  if (contentType && contentType.startsWith('image/')) return contentType;
  return 'image/jpeg';
}

/** 下载历史/当前消息里的图片，转为模型可消费的 ImageContent。 */
export async function downloadHistoryImages(
  channel: LarkChannel,
  refs: HistoryImageRef[],
): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const ref of refs) {
    try {
      const { buffer, contentType } = await channel.downloadResourceWithMeta(
        ref.messageId,
        ref.fileKey,
        'image',
      );
      images.push({
        type: 'image',
        data: buffer.toString('base64'),
        mimeType: guessMimeType(contentType),
      });
    } catch (err) {
      console.warn('[history] image download failed', ref.messageId, ref.fileKey, err);
    }
  }
  return images;
}
