import type lark from '@larksuiteoapi/node-sdk';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { runAgentTurn } from './agent.js';
import { config } from './config.js';
import { fetchChatHistory, renderHistory } from './history.js';
import { systemPrompt } from './llm.js';
import { getTracer } from './tracing.js';

interface ActiveTurn {
  messageId: string;
  reactionId?: string;
  reactionRemoved: boolean;
  controller: AbortController;
}

function incomingText(msg: NormalizedMessage): string {
  const text = msg.content.trim();
  if (text) return text;
  if (msg.resources.some((r) => r.type === 'image')) return '[图片]';
  return '';
}

export class Orchestrator {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly turnChains = new Map<string, Promise<void>>();

  constructor(
    private readonly client: lark.Client,
    private readonly channel: LarkChannel,
  ) {}

  async handleMessage(msg: NormalizedMessage): Promise<void> {
    if (this.isSelfMessage(msg)) return;
    const text = incomingText(msg);
    if (!text) return;
    if (Date.now() - msg.createTime > config.staleMessageThresholdMs) return;

    await this.cancelActiveTurn(msg.chatId);

    const prev = this.turnChains.get(msg.chatId)?.catch(() => {}) ?? Promise.resolve();
    const settled = prev
      .then(() => this.runTurn(msg, text))
      .catch((err) => console.error('[turn] 失败', msg.chatId, msg.messageId, err));
    this.turnChains.set(msg.chatId, settled);
    void settled.then(() => {
      if (this.turnChains.get(msg.chatId) === settled) this.turnChains.delete(msg.chatId);
    });
  }

  private isSelfMessage(msg: NormalizedMessage): boolean {
    if (msg.senderId === config.lark.appId) return true;
    try {
      const me = this.channel.getBotIdentity();
      return Boolean(me.openId && msg.senderId === me.openId);
    } catch {
      return false;
    }
  }

  private async runTurn(msg: NormalizedMessage, text: string): Promise<void> {
    const reactionId = await this.addOnItReaction(msg.messageId);
    const turn: ActiveTurn = {
      messageId: msg.messageId,
      reactionId,
      reactionRemoved: false,
      controller: new AbortController(),
    };
    this.activeTurns.set(msg.chatId, turn);
    try {
      await this.process(msg, text, turn.controller.signal);
    } catch (err) {
      console.error('[turn] 失败', msg.chatId, msg.messageId, err);
      if (!turn.controller.signal.aborted) {
        await this.channel
          .send(msg.chatId, { text: '抱歉，刚刚处理消息时出了点问题，请稍后再试。' })
          .catch(() => {});
      }
    } finally {
      if (this.activeTurns.get(msg.chatId) === turn) this.activeTurns.delete(msg.chatId);
      await this.removeOnItReactionOnce(turn);
    }
  }

  private async process(msg: NormalizedMessage, text: string, signal: AbortSignal): Promise<void> {
    await getTracer().startActiveSpan('chat.turn', async (span) => {
      try {
        span.setAttributes({ 'lark_agent.chat_id': msg.chatId, 'lark_agent.message_id': msg.messageId });

        let historyBlock = '';
        try {
          const lines = await fetchChatHistory(this.client, msg.chatId, {
            beforeMs: msg.createTime,
            excludeMessageId: msg.messageId,
          });
          historyBlock = renderHistory(lines);
        } catch (err) {
          console.warn('[turn] 历史拉取失败', msg.chatId, err);
        }

        const userPrompt = [
          historyBlock ? `[最近聊天记录]\n${historyBlock}` : '',
          msg.replyToMessageId ? `[当前消息是对消息 ${msg.replyToMessageId} 的回复]` : '',
          `[用户消息]\n${text}`,
        ]
          .filter(Boolean)
          .join('\n\n');

        const result = await runAgentTurn(
          systemPrompt,
          userPrompt,
          {
            sendPost: async ({ markdown }) => {
              if (signal.aborted) return;
              await this.channel.send(msg.chatId, { markdown });
            },
          },
          signal,
        );

        if (result.aborted) return;
        if (!result.delivered && result.finalText) {
          await this.channel.send(msg.chatId, { text: result.finalText });
        } else if (!result.delivered) {
          await this.channel
            .send(msg.chatId, { text: '抱歉，刚刚处理消息时出了点问题，请稍后再试。' })
            .catch(() => {});
        }
      } finally {
        span.end();
      }
    });
  }

  private async cancelActiveTurn(chatId: string): Promise<void> {
    const active = this.activeTurns.get(chatId);
    if (!active) return;
    this.activeTurns.delete(chatId);
    active.controller.abort();
    console.log(`[turn] 新消息到达，中止未完成轮次 ${active.messageId}`);
    await this.removeOnItReactionOnce(active);
  }

  private async removeOnItReactionOnce(turn: ActiveTurn): Promise<void> {
    if (!turn.reactionId || turn.reactionRemoved) return;
    turn.reactionRemoved = true;
    await this.removeOnItReaction(turn.messageId, turn.reactionId);
  }

  private async addOnItReaction(messageId: string): Promise<string | undefined> {
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'OnIt' } },
      });
      return res.data?.reaction_id;
    } catch (err) {
      console.warn('[reaction] 添加失败', err);
      return undefined;
    }
  }

  private async removeOnItReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (err) {
      console.warn('[reaction] 移除失败', err);
    }
  }
}
