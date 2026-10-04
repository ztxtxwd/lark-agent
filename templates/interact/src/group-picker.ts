import type { ChatOption } from './types.js';

/** 群聊选择表单卡：下拉选群 + 提交后由 bot 把草稿卡发到该群。 */
export function buildGroupPickerCard(chats: ChatOption[], hint?: string) {
  const options = chats.map((c) => ({
    text: { tag: 'plain_text', content: truncate(c.name, 40) },
    value: c.chatId,
  }));

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: false,
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '选择要投放的群聊' },
      subtitle: { tag: 'plain_text', content: '机器人所在的群 · 选好后点发送' },
    },
    body: {
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          content:
            hint ??
            '已收到你的互动卡片。请选择要发送的群聊（列表来自「获取用户或机器人所在的群列表」API，当前为**机器人所在群**）。',
        },
        {
          tag: 'form',
          name: 'dispatch_form',
          elements: [
            {
              tag: 'select_static',
              name: 'chat_id',
              required: true,
              placeholder: { tag: 'plain_text', content: chats.length ? '请选择群聊' : '暂无可用群聊' },
              width: 'fill',
              options,
            },
            {
              tag: 'button',
              name: 'submit_dispatch',
              type: 'primary_filled',
              width: 'default',
              text: { tag: 'plain_text', content: '发送到群聊' },
              form_action_type: 'submit',
              behaviors: [{ type: 'callback', value: { action: 'dispatch_card' } }],
              value: { action: 'dispatch_card' },
              disabled: chats.length === 0,
            },
          ],
        },
      ],
    },
  };
}

export function buildDispatchDoneCard(chatName: string, chatId: string) {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '已发送到群聊' },
    },
    body: {
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          content: `卡片已发送到 **${escapeMd(chatName)}**（\`${chatId}\`）。\n群成员点击选项后，bot 会更新卡片（如在选项下追加投票人）。`,
        },
      ],
    },
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]()])/g, '\\$1');
}
