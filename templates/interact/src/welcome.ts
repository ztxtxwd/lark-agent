import type { BotAddedEvent, LarkChannel } from '@larksuite/channel';
import { config } from './config.js';

type ChannelRawOn = {
  onRawEvent(eventType: string, handler: (payload: unknown) => void | Promise<void>): () => void;
};

function parseP2pChatCreate(raw: unknown): { chatId: string; userName?: string } | undefined {
  const body = raw as {
    event?: { chat_id?: string; user?: { name?: string } };
    chat_id?: string;
    user?: { name?: string };
  };
  const evt = body.event ?? body;
  if (!evt.chat_id) return undefined;
  return { chatId: evt.chat_id, userName: evt.user?.name };
}

function usageMarkdown(botName: string, userName?: string): string {
  const hi = userName ? `${userName}，你好` : '你好';
  return [
    `${hi}，我是 **${botName}**。`,
    '',
    '**用法（私聊）**',
    '1. 把准备好的互动卡片转发给我，或粘贴 schema 2.0 JSON',
    '2. 我回复「选择群聊」表单（群列表来自机器人所在群）',
    '3. 选好群并提交后，卡片会发到该群',
    '4. 群成员点击选项时，我会更新卡片（例如在选项下追加投票人）',
  ].join('\n');
}

/** 进群 / 首次单聊时说明用法，不自动发卡。 */
export function registerWelcomeHandlers(channel: LarkChannel): void {
  const greeted = new Set<string>();

  const greet = async (chatId: string, markdown: string): Promise<void> => {
    if (greeted.has(chatId)) return;
    greeted.add(chatId);
    try {
      await channel.send(chatId, { markdown });
    } catch (err) {
      greeted.delete(chatId);
      console.warn('[welcome] 发送失败', chatId, err);
    }
  };

  channel.on('botAdded', (evt: BotAddedEvent) => {
    void greet(
      evt.chatId,
      `你好，我是 **${config.lark.botName}**。把我拉进群后，请在**私聊**里把互动卡片发给我，再选择本群投放。`,
    );
  });

  (channel as unknown as ChannelRawOn).onRawEvent('p2p_chat_create', (raw) => {
    const evt = parseP2pChatCreate(raw);
    if (!evt) return;
    void greet(evt.chatId, usageMarkdown(config.lark.botName, evt.userName));
  });
}
