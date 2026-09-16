import type lark from '@larksuiteoapi/node-sdk';
import type { MentionInfo } from '@larksuite/channel';

/** 可在卡片 lark_md 里 <at id=…> 引用的用户。 */
export interface MentionableUser {
  name: string;
  openId: string;
}

const MAX_CHAT_MEMBERS = 200;

function addUser(map: Map<string, MentionableUser>, u: MentionableUser | undefined): void {
  if (!u?.openId?.startsWith('ou_') || !u.name?.trim()) return;
  const key = u.openId;
  const prev = map.get(key);
  if (!prev || u.name.length > prev.name.length) map.set(key, { name: u.name.trim(), openId: u.openId });
}

/** 从 channel 归一化消息的 mentions 提取 open_id。 */
export function mentionUsersFromMessage(mentions: MentionInfo[] | undefined): MentionableUser[] {
  const out: MentionableUser[] = [];
  for (const m of mentions ?? []) {
    const openId = m.openId?.trim();
    const name = m.name?.trim();
    if (openId?.startsWith('ou_') && name) out.push({ name, openId });
  }
  return out;
}

/** 从 im.message.list 原始 item 的 mentions 字段提取 open_id。 */
export function mentionUsersFromHistoryItems(
  items: Array<{ mentions?: Array<{ name?: string; id?: string; id_type?: string }> }>,
): MentionableUser[] {
  const out: MentionableUser[] = [];
  for (const item of items) {
    for (const m of item.mentions ?? []) {
      const id = m.id?.trim();
      const name = m.name?.trim();
      if (!name || !id?.startsWith('ou_')) continue;
      if (m.id_type && m.id_type !== 'open_id') continue;
      out.push({ name, openId: id });
    }
  }
  return out;
}

/** 拉取当前群成员（单聊跳过；失败返回空数组）。 */
export async function fetchChatMemberUsers(
  client: lark.Client,
  chatId: string,
  chatType: 'p2p' | 'group',
): Promise<MentionableUser[]> {
  if (chatType !== 'group') return [];
  const users: MentionableUser[] = [];
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < 5 && users.length < MAX_CHAT_MEMBERS; page++) {
      const res = await client.im.v1.chatMembers.get({
        path: { chat_id: chatId },
        params: {
          member_id_type: 'open_id',
          page_size: Math.min(100, MAX_CHAT_MEMBERS - users.length),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      if (res.code !== undefined && res.code !== 0) break;
      for (const item of res.data?.items ?? []) {
        const openId = item.member_id?.trim();
        const name = item.name?.trim();
        if (openId?.startsWith('ou_') && name) users.push({ name, openId });
      }
      if (!res.data?.has_more || !res.data.page_token) break;
      pageToken = res.data.page_token;
    }
  } catch {
    // 无权限或机器人在群外时跳过
  }
  return users;
}

/** 合并去重后渲染为 prompt 块；空则返回空串。 */
export function renderMentionableUsers(users: MentionableUser[]): string {
  if (users.length === 0) return '';
  const map = new Map<string, MentionableUser>();
  for (const u of users) addUser(map, u);
  const lines = [...map.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .map((u) => `- ${u.name} (${u.openId})`);
  return (
    `[可 @ 的人员]\n` +
    `卡片 header 的 title/subtitle 或 body markdown 里要真正 @ 并通知对方，必须用 tag:"lark_md" 且 content 写 <at id=open_id></at>；` +
    `plain_text 里写 "@姓名" 只是普通文字。header 不支持 person 组件。\n` +
    lines.join('\n')
  );
}

/** 合并消息 mentions、历史 mentions、群成员为一份名单。 */
export function mergeMentionableUsers(...groups: MentionableUser[][]): MentionableUser[] {
  const map = new Map<string, MentionableUser>();
  for (const group of groups) for (const u of group) addUser(map, u);
  return [...map.values()];
}
