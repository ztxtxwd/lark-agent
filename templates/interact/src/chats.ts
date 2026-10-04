import type lark from '@larksuiteoapi/node-sdk';
import type { ChatOption } from './types.js';

const PAGE_SIZE = 50;
const MAX_CHATS = 100;

/**
 * 获取机器人所在的群列表（tenant_access_token）。
 * 对应开放平台：获取用户或机器人所在的群列表 GET /im/v1/chats
 * https://open.feishu.cn/document/server-docs/group/chat/list
 */
export async function listBotChats(client: lark.Client): Promise<ChatOption[]> {
  const out: ChatOption[] = [];
  let pageToken: string | undefined;

  do {
    const res = await client.im.v1.chat.list({
      params: {
        sort_type: 'ByCreateTimeAsc',
        page_size: PAGE_SIZE,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res.code !== 0) {
      throw new Error(`获取群列表失败：${res.msg || res.code}`);
    }
    for (const item of res.data?.items ?? []) {
      if (!item.chat_id) continue;
      if (item.chat_status && item.chat_status !== 'normal') continue;
      out.push({
        chatId: item.chat_id,
        name: item.name?.trim() || item.chat_id,
      });
      if (out.length >= MAX_CHATS) return out;
    }
    pageToken = res.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);

  return out;
}
