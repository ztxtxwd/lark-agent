import type { BotAddedEvent, LarkChannel } from '@larksuite/channel';
import { config } from './config.js';

type ChannelRawOn = {
  onRawEvent(eventType: string, handler: (payload: unknown) => void | Promise<void>): () => void;
};

function p2pWelcome(botName: string, userName?: string): string {
  const hi = userName ? `${userName}，你好` : '你好';
  return [
    `${hi}，我是 **${botName}**，飞书卡片助手。`,
    '',
    '直接说你要什么卡片就行，例如：「帮我做一张周报卡片」。不满意接着改。',
  ].join('\n');
}

function groupWelcome(botName: string): string {
  return [
    `大家好，我是 **${botName}**。`,
    '',
    '在群里 @ 我并描述需求，我可以生成或修改飞书卡片。',
  ].join('\n');
}

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

/** 进群或单聊创建时打一声招呼。 */
export function registerWelcomeHandlers(channel: LarkChannel): void {
  const greeted = new Set<string>();

  const sendWelcome = async (chatId: string, markdown: string): Promise<void> => {
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
    void sendWelcome(evt.chatId, groupWelcome(config.lark.botName));
  });

  (channel as unknown as ChannelRawOn).onRawEvent('p2p_chat_create', (raw) => {
    const evt = parseP2pChatCreate(raw);
    if (!evt) return;
    void sendWelcome(evt.chatId, p2pWelcome(config.lark.botName, evt.userName));
  });
}
