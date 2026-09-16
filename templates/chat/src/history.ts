import type lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';

type MessageItem = {
  message_id?: string;
  msg_type?: string;
  body?: { content?: string };
  mentions?: Array<{ key?: string; name?: string }>;
  sender?: { sender_type?: string };
  create_time?: string;
  deleted?: boolean;
};

export interface HistoryLine {
  role: 'user' | 'bot';
  text: string;
}

function parseTextContent(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

function parsePostContent(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as Record<string, { content?: unknown[][] } | undefined>;
    const locale = parsed.zh_cn ?? parsed.en_us ?? Object.values(parsed)[0];
    const parts: string[] = [];
    for (const paragraph of locale?.content ?? []) {
      for (const node of paragraph ?? []) {
        const tag = (node as { tag?: string }).tag;
        if (tag === 'text' || tag === 'a' || tag === 'md') {
          parts.push(String((node as { text?: string }).text ?? ''));
        } else if (tag === 'at') {
          parts.push(`@${(node as { user_name?: string }).user_name ?? ''}`);
        } else if (tag === 'img') {
          parts.push('[图片]');
        }
      }
      parts.push('\n');
    }
    return parts.join('');
  } catch {
    return '';
  }
}

function hydrateMentions(text: string, item: MessageItem): string {
  let out = text;
  for (const m of item.mentions ?? []) {
    if (m.key && m.name) out = out.replaceAll(m.key, `@${m.name}`);
  }
  return out;
}

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
    case 'interactive':
      return '[卡片]';
    default:
      return `[${msgType}]`;
  }
}

function toHistoryLine(item: MessageItem, excludeMessageId?: string): HistoryLine | undefined {
  if (!item.msg_type || item.deleted === true) return undefined;
  if (excludeMessageId && item.message_id === excludeMessageId) return undefined;
  const role: 'user' | 'bot' = item.sender?.sender_type === 'app' ? 'bot' : 'user';
  let text: string;
  switch (item.msg_type) {
    case 'text':
      text = hydrateMentions(parseTextContent(item.body?.content), item).trim();
      break;
    case 'post':
      text = hydrateMentions(parsePostContent(item.body?.content), item).trim();
      break;
    default:
      text = describeType(item.msg_type);
  }
  if (!text) return undefined;
  return { role, text };
}

export async function fetchChatHistory(
  client: lark.Client,
  chatId: string,
  opts: { beforeMs: number; excludeMessageId?: string },
): Promise<HistoryLine[]> {
  const res = await client.im.message.list({
    params: {
      container_id_type: 'chat',
      container_id: chatId,
      sort_type: 'ByCreateTimeDesc',
      end_time: String(Math.floor(opts.beforeMs / 1000)),
      page_size: Math.min(50, config.historyLimit),
    },
  });

  const items = [...((res.data?.items ?? []) as MessageItem[])].sort(
    (a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0),
  );

  const lines: HistoryLine[] = [];
  for (const item of items) {
    const line = toHistoryLine(item, opts.excludeMessageId);
    if (line) lines.push(line);
  }
  return lines;
}

export function renderHistory(lines: HistoryLine[]): string {
  return lines
    .map((l) => `${l.role === 'user' ? '用户' : '机器人'}: ${l.text}`)
    .join('\n');
}
