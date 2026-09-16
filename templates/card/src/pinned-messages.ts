import type lark from '@larksuiteoapi/node-sdk';
import { parsePostContent, parseTextContent } from './history.js';
import { extractCardSummary } from './parent-card.js';

export interface PinnedMessage {
  messageId: string;
  kind: 'text' | 'card';
  role?: 'user' | 'bot';
  /** 文字/post 消息的完整正文 */
  text?: string;
  /** 卡片消息的 config.summary.content */
  summary?: string;
  pinnedAt: number;
}

type MessageItem = {
  message_id?: string;
  msg_type?: string;
  body?: { content?: string };
  chat_id?: string;
  deleted?: boolean;
  sender?: { sender_type?: string };
};

type PinRecord = {
  message_id?: string;
  chat_id?: string;
  create_time?: string;
};

/** SDK 运行时已有 im.v1.pin，类型定义尚未跟上。 */
type PinApi = {
  create: (opts: { data: { message_id: string } }) => Promise<{ data?: { pin?: PinRecord } }>;
  delete: (opts: { path: { message_id: string } }) => Promise<unknown>;
  list: (opts: {
    params: { chat_id: string; page_size?: number; page_token?: string };
  }) => Promise<{ data?: { items?: PinRecord[]; has_more?: boolean; page_token?: string } }>;
};

function pinApi(client: lark.Client): PinApi {
  return (client as lark.Client & { im: { v1: { pin: PinApi } } }).im.v1.pin;
}

async function fetchMessageItem(
  client: lark.Client,
  messageId: string,
): Promise<MessageItem> {
  const res = await client.im.message.get({
    path: { message_id: messageId },
    params: { card_msg_content_type: 'user_card_content' },
  });
  const item = res.data?.items?.[0];
  if (!item) throw new Error(`未找到消息 ${messageId}`);
  return item as MessageItem;
}

function messageToPinEntry(item: MessageItem): PinnedMessage {
  const messageId = item.message_id;
  if (!messageId) throw new Error('消息缺少 message_id');
  const role: 'user' | 'bot' = item.sender?.sender_type === 'app' ? 'bot' : 'user';

  switch (item.msg_type) {
    case 'text': {
      const text = parseTextContent(item.body?.content).trim();
      if (!text) throw new Error('该消息没有可记忆的文字内容');
      return { messageId, kind: 'text', role, text, pinnedAt: Date.now() };
    }
    case 'post': {
      const text = parsePostContent(item.body?.content).trim();
      if (!text) throw new Error('该消息没有可记忆的文字内容');
      return { messageId, kind: 'text', role, text, pinnedAt: Date.now() };
    }
    case 'interactive': {
      const summary = extractCardSummary(item.body?.content);
      return {
        messageId,
        kind: 'card',
        summary: summary.trim() || '(无摘要)',
        pinnedAt: Date.now(),
      };
    }
    default:
      throw new Error(
        `消息类型 ${item.msg_type ?? '未知'} 暂不支持记忆；仅支持文字、富文本与卡片`,
      );
  }
}

/** 拉取会话内全部 Pin 记录（飞书 API 分页）。 */
async function listPinRecords(client: lark.Client, chatId: string): Promise<PinRecord[]> {
  const items: PinRecord[] = [];
  let pageToken: string | undefined;
  do {
    const res = await pinApi(client).list({
      params: {
        chat_id: chatId,
        page_size: 50,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    items.push(...(res.data?.items ?? []));
    pageToken = res.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);
  return items;
}

/** 读取当前会话已 Pin 的消息（按 Pin 时间升序），内容实时从 message.get 拉取。 */
export async function getPinnedMessages(
  client: lark.Client,
  chatId: string,
): Promise<PinnedMessage[]> {
  let records: PinRecord[];
  try {
    records = await listPinRecords(client, chatId);
  } catch (err) {
    console.warn('[pins] list failed', chatId, err);
    return [];
  }

  const sorted = [...records].sort(
    (a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0),
  );

  const results: PinnedMessage[] = [];
  for (const rec of sorted) {
    if (!rec.message_id) continue;
    try {
      const item = await fetchMessageItem(client, rec.message_id);
      if (item.deleted) continue;
      const entry = messageToPinEntry(item);
      entry.pinnedAt = Number(rec.create_time ?? entry.pinnedAt);
      results.push(entry);
    } catch (err) {
      console.warn('[pins] message fetch failed', rec.message_id, err);
    }
  }
  return results;
}

/** Pin 一条消息（飞书 im.v1.pin.create）；已 Pin 则幂等返回。 */
export async function pinMessage(
  client: lark.Client,
  chatId: string,
  messageId: string,
): Promise<PinnedMessage> {
  const trimmed = messageId.trim();
  if (!trimmed) throw new Error('message_id 不能为空');

  const item = await fetchMessageItem(client, trimmed);
  if (item.deleted) throw new Error(`消息 ${trimmed} 已被删除`);
  if (item.chat_id && item.chat_id !== chatId) {
    throw new Error(`消息 ${trimmed} 不属于当前会话`);
  }

  const entry = messageToPinEntry(item);
  const res = await pinApi(client).create({ data: { message_id: trimmed } });
  const createTime = res.data?.pin?.create_time;
  if (createTime) entry.pinnedAt = Number(createTime);
  return entry;
}

/** 取消 Pin（飞书 im.v1.pin.delete）。 */
export async function unpinMessage(client: lark.Client, messageId: string): Promise<boolean> {
  const trimmed = messageId.trim();
  if (!trimmed) throw new Error('message_id 不能为空');

  try {
    await pinApi(client).delete({ path: { message_id: trimmed } });
    return true;
  } catch (err) {
    console.warn('[pins] unpin failed', trimmed, err);
    return false;
  }
}

/** 渲染 Pin 消息块，供拼入 userPrompt。 */
export function renderPinnedMessages(pins: PinnedMessage[]): string {
  if (pins.length === 0) return '';
  const lines: string[] = [];
  for (const p of pins) {
    if (p.kind === 'card') {
      const summary = (p.summary ?? '').trim() || '(无摘要)';
      lines.push(`- ${p.messageId}: ${summary}`);
    } else {
      const role = p.role === 'bot' ? '机器人' : '用户';
      lines.push(`${role}: mid:${p.messageId} ${p.text ?? ''}`);
    }
  }
  return lines.join('\n');
}

/** 已 Pin 的卡片 message_id 集合，用于回复目标判定等。 */
export function pinnedCardMessageIds(pins: PinnedMessage[]): string[] {
  return pins.filter((p) => p.kind === 'card').map((p) => p.messageId);
}
