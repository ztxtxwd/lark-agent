import type lark from '@larksuiteoapi/node-sdk';
import type { LarkChannel, NormalizedMessage, SendInput } from '@larksuite/channel';
import { config } from './config.js';
import { systemPrompt } from './llm.js';
import {
  downloadHistoryImages,
  fetchChatHistory,
  findLatestCardInMessageGet,
  findLatestCardMessageId,
  renderBotCardsList,
  renderHistory,
} from './history.js';
import type { HistoryImageRef } from './history.js';
import { shouldLoadLatestCard } from './edit-intent.js';
import {
  mergeMentionableUsers,
  mentionUsersFromMessage,
  renderMentionableUsers,
} from './mentionable-users.js';
import { checkCardDsl, fetchMessageDetail, prepareCardReplyContext } from './parent-card.js';
import { pinMessage, unpinMessage } from './pinned-messages.js';
import { runAgentTurn } from './agent.js';
import { getTracer, markSpan, setSpanIO } from './tracing.js';

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
        await this.sendMessage(msg, {
          text: '抱歉，刚刚处理消息时出了点问题，请稍后再试。',
        }).catch(() => {});
      }
    } finally {
      if (this.activeTurns.get(msg.chatId) === turn) this.activeTurns.delete(msg.chatId);
      await this.removeOnItReactionOnce(turn);
    }
  }

  private async process(msg: NormalizedMessage, text: string, signal: AbortSignal): Promise<void> {
    const sendMessage = async (
      input: SendInput,
      replyToMessageId?: string,
    ): Promise<string | undefined> => {
      if (signal.aborted) return undefined;
      return this.sendMessage(msg, input, replyToMessageId);
    };

    const sendPost = async (input: {
      title?: string;
      markdown: string;
      replyToMessageId?: string;
    }): Promise<void> => {
      const { title, markdown, replyToMessageId } = input;
      if (title) {
        await sendMessage(
          { post: { zh_cn: { title, content: [[{ tag: 'md', text: markdown }]] } } },
          replyToMessageId,
        );
      } else {
        await sendMessage({ markdown }, replyToMessageId);
      }
    };

    await getTracer().startActiveSpan('chat.turn', async (span) => {
      try {
        markSpan(span, 'chain');
        span.setAttributes({
          'lark_agent.chat_id': msg.chatId,
          'lark_agent.message_id': msg.messageId,
        });
        setSpanIO(span, {
          chat_id: msg.chatId,
          message_id: msg.messageId,
          user_message: text,
        });

        const imageRefs: HistoryImageRef[] = [];
        for (const r of msg.resources) {
          if (r.type !== 'image' || !r.fileKey) continue;
          imageRefs.push({ messageId: msg.messageId, fileKey: r.fileKey });
        }

        let historyBlock = '';
        let botCardsBlock = '';
        try {
          const history = await fetchChatHistory(this.client, msg.chatId, {
            beforeMs: msg.createTime,
            excludeMessageId: msg.messageId,
          });
          const rendered = renderHistory(history.lines);
          if (rendered) historyBlock = `[对话历史]\n${rendered}`;
          const cards = renderBotCardsList(history.botCards);
          if (cards) botCardsBlock = `[最近机器人卡片]\n${cards}`;
          for (const ref of history.imageRefs) {
            if (
              !imageRefs.some(
                (r) => r.messageId === ref.messageId && r.fileKey === ref.fileKey,
              )
            ) {
              imageRefs.push(ref);
            }
          }
        } catch (err) {
          console.warn('[turn] 拉取对话历史失败', msg.chatId, err);
        }

        const contextImages =
          imageRefs.length > 0 ? await downloadHistoryImages(this.channel, imageRefs) : [];

        const sender =
          msg.senderId?.startsWith('ou_') && msg.senderName?.trim()
            ? [{ name: msg.senderName.trim(), openId: msg.senderId }]
            : [];
        const mentionBlock = renderMentionableUsers(
          mergeMentionableUsers(mentionUsersFromMessage(msg.mentions), sender),
        );

        let cardDraftBlock = '';
        if (shouldLoadLatestCard(msg, text)) {
          const cardId = await resolveCardToEdit(this.client, msg);
          if (cardId) {
            try {
              const draft = await prepareCardReplyContext(this.client, cardId);
              cardDraftBlock =
                `[当前要修改的卡片是 ${cardId}，modify_card 的目标必须是该 message_id]\n\n` +
                draft.brief;
            } catch (err) {
              console.warn('[turn] 最近卡片底稿不可用', cardId, err);
            }
          }
        }

        const userPrompt = [
          mentionBlock,
          botCardsBlock,
          historyBlock,
          cardDraftBlock,
          !cardDraftBlock && msg.replyToMessageId
            ? `[当前消息是对消息 ${msg.replyToMessageId} 的回复。若要改这张卡，先 get_message_detail 再 modify_card。]`
            : '',
          `[用户消息]\n${text}`,
        ]
          .filter(Boolean)
          .join('\n\n');

        const result = await runAgentTurn(
          systemPrompt,
          userPrompt,
          {
            sendPost,
            sendCard: async (dsl, opts) => {
              const messageId = await sendMessage(
                { card: dsl as object },
                opts?.replyToMessageId,
              );
              if (!messageId) throw new Error('卡片发送失败');
              return messageId;
            },
            getMessageDetail: (messageId) => fetchMessageDetail(this.client, messageId),
            pinMessage: async (messageId) => {
              const entry = await pinMessage(this.client, msg.chatId, messageId);
              if (entry.kind === 'card') {
                return `已记忆卡片 ${entry.messageId}（摘要：${entry.summary ?? '(无摘要)'}）。`;
              }
              return `已记忆文字消息 ${entry.messageId}。`;
            },
            unpinMessage: async (messageId) => {
              const removed = await unpinMessage(this.client, messageId);
              return removed
                ? `已取消记忆 ${messageId}。`
                : `消息 ${messageId} 不在当前会话记忆中。`;
            },
          },
          signal,
          contextImages.length > 0 ? contextImages : undefined,
        );

        setSpanIO(span, undefined, {
          delivered: result.delivered,
          aborted: result.aborted,
          output: result.finalText,
        });

        if (result.aborted) return;
        if (!result.delivered && result.finalText) {
          const bare = parseBareCardDsl(result.finalText);
          if (bare) {
            await sendMessage({ card: bare as object });
          } else {
            await sendMessage({ text: result.finalText });
          }
        } else if (!result.delivered) {
          await sendMessage({
            text: '抱歉，刚刚处理消息时出了点问题，请稍后再试。',
          }).catch(() => {});
        }
      } finally {
        span.end();
      }
    });
  }

  private async sendMessage(
    msg: NormalizedMessage,
    input: SendInput,
    replyToMessageId?: string,
  ): Promise<string | undefined> {
    const replyTo = replyToMessageId?.trim();
    if (replyTo) {
      const result = await this.channel.send(msg.chatId, input, {
        replyTo,
        replyInThread: Boolean(msg.threadId),
      });
      return result.messageId;
    }
    const result = await this.channel.send(msg.chatId, input);
    return result.messageId;
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

async function resolveCardToEdit(
  client: lark.Client,
  msg: NormalizedMessage,
): Promise<string | undefined> {
  if (msg.rawContentType === 'interactive') return msg.messageId;
  if (msg.rawContentType === 'merge_forward') {
    const fromForward = await findLatestCardInMessageGet(client, msg.messageId);
    if (fromForward) return fromForward;
  }
  return findLatestCardMessageId(client, msg.chatId, { beforeMs: msg.createTime });
}

function parseBareCardDsl(text: string): unknown | undefined {
  if (!text.includes('"schema"') || !text.includes('"body"')) return undefined;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonText = fenced?.[1]?.trim() ?? extractJsonObject(text);
  if (!jsonText) return undefined;
  try {
    let parsed: unknown = JSON.parse(jsonText);
    if (parsed && typeof parsed === 'object' && 'dsl' in (parsed as Record<string, unknown>)) {
      parsed = (parsed as { dsl: unknown }).dsl;
    }
    const checked = checkCardDsl(parsed);
    if (checked.errors.length > 0 || !checked.card) return undefined;
    return checked.card;
  } catch {
    return undefined;
  }
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
