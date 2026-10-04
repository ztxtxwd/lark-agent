import type {
  CardActionEvent,
  CardActionResponse,
  LarkChannel,
  NormalizedMessage,
} from '@larksuite/channel';
import type lark from '@larksuiteoapi/node-sdk';
import {
  fetchCardFromMessage,
  parseCardFromText,
  prepareCardForDispatch,
  rearmCardAfterFetch,
} from './card-io.js';
import { sealCardState } from './card-state.js';
import { listBotChats } from './chats.js';
import { buildDispatchDoneCard, buildGroupPickerCard } from './group-picker.js';
import { applyPersonVote, parseDispatchAction, parseVoteAction } from './person-vote.js';
import type { DispatchedCard, PendingDispatch } from './types.js';

/** form 消息 → 待投放草稿（进程内；重启后重发即可） */
const pendingByFormMessage = new Map<string, PendingDispatch>();
const pendingByOperator = new Map<string, PendingDispatch>();
/** 已投放卡进程内缓存；重启后靠飞书回读 + zwsteg 恢复 */
const dispatchedByMessage = new Map<string, DispatchedCard>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function handleDeveloperMessage(
  client: lark.Client,
  channel: LarkChannel,
  msg: NormalizedMessage,
): Promise<void> {
  if (msg.chatType !== 'p2p') return;

  let card: Record<string, unknown> | null = null;
  if (msg.rawContentType === 'interactive') {
    card = await fetchCardFromMessage(client, msg.messageId);
  } else {
    card = parseCardFromText(msg.content);
  }

  if (!card) {
    await channel.reply(msg, {
      markdown:
        '请发给我一张**准备好的互动卡片**（转发卡片，或粘贴 schema 2.0 JSON）。\n我会回复「选择群聊」表单，选好后把卡片发到该群，并响应群成员的点击。',
    });
    return;
  }

  const chats = await listBotChats(client);
  const prepared = prepareCardForDispatch(card);
  const draft: PendingDispatch = {
    card: prepared,
    sourceMessageId: msg.messageId,
    operatorOpenId: msg.senderId,
    chats,
  };

  const picker = buildGroupPickerCard(
    chats,
    chats.length
      ? '已收到互动卡片。请选择要投放的群聊后点击 **发送到群聊**。'
      : '已收到互动卡片，但机器人当前**不在任何群**里。请先把机器人拉进目标群，再重新发卡片给我。',
  );

  const sent = await channel.reply(msg, { card: picker });
  pendingByFormMessage.set(sent.messageId, draft);
  pendingByOperator.set(msg.senderId, draft);
}

export async function handleCardAction(
  client: lark.Client,
  channel: LarkChannel,
  evt: CardActionEvent,
): Promise<CardActionResponse> {
  console.log(
    '[cardAction]',
    evt.messageId,
    'tag=',
    evt.action.tag,
    'value=',
    summarizeValue(evt.action.value),
    'form=',
    evt.action.formValue ? Object.keys(evt.action.formValue) : undefined,
  );

  if (parseDispatchAction(evt.action.value) || evt.action.formValue) {
    return handleDispatchSubmit(channel, evt);
  }

  const dispatched = await resolveDispatched(client, evt);
  if (dispatched) {
    return handleDispatchedInteraction(evt, dispatched);
  }

  return { toast: { type: 'warning', content: '卡片状态已失效，请让开发者重新投放' } };
}

async function resolveDispatched(
  client: lark.Client,
  evt: CardActionEvent,
): Promise<DispatchedCard | undefined> {
  const cached = dispatchedByMessage.get(evt.messageId);
  if (cached) return cached;

  try {
    const fetched = await fetchCardFromMessage(client, evt.messageId);
    // 回读卡缺按钮 callback、element_id 常被重编号；必须重装后再回写，否则整卡会坏掉
    const { card, source } = rearmCardAfterFetch(fetched);
    const recovered: DispatchedCard = { card, chatId: evt.chatId };
    dispatchedByMessage.set(evt.messageId, recovered);
    console.log('[recover]', evt.messageId, `(${source}→rearm)`);
    return recovered;
  } catch (err) {
    console.warn('[recover] 无法从飞书恢复卡片', evt.messageId, err);
    return undefined;
  }
}

function summarizeValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return value.slice(0, 120);
  if (isRecord(value)) return value;
  return typeof value;
}

async function handleDispatchSubmit(
  channel: LarkChannel,
  evt: CardActionEvent,
): Promise<CardActionResponse> {
  const draft =
    pendingByFormMessage.get(evt.messageId) ?? pendingByOperator.get(evt.operator.openId);
  if (!draft) {
    return {
      toast: { type: 'warning', content: '草稿已失效，请重新私聊发送互动卡片' },
    };
  }

  const chatId = readFormChatId(evt);
  if (!chatId) {
    return { toast: { type: 'warning', content: '请先选择一个群聊' } };
  }

  const chatName = draft.chats.find((c) => c.chatId === chatId)?.name ?? chatId;

  try {
    const result = await channel.send(chatId, { card: draft.card });
    dispatchedByMessage.set(result.messageId, {
      card: structuredClone(draft.card) as Record<string, unknown>,
      chatId,
    });
    pendingByFormMessage.delete(evt.messageId);
    pendingByOperator.delete(draft.operatorOpenId);

    return {
      toast: { type: 'success', content: `已发送到 ${chatName}` },
      card: { type: 'raw', data: buildDispatchDoneCard(chatName, chatId) },
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[dispatch] 发送失败', chatId, err);
    return {
      toast: { type: 'error', content: `发送失败：${detail.slice(0, 80)}` },
    };
  }
}

function readFormChatId(evt: CardActionEvent): string | undefined {
  const form = evt.action.formValue;
  if (form && typeof form.chat_id === 'string' && form.chat_id) return form.chat_id;
  if (typeof evt.action.option === 'string' && evt.action.option.startsWith('oc_')) {
    return evt.action.option;
  }
  return undefined;
}

/**
 * 群内投票交互：在 callback 响应里直接回写整卡（含 zwsteg 封印）。
 */
function handleDispatchedInteraction(
  evt: CardActionEvent,
  dispatched: DispatchedCard,
): CardActionResponse {
  const openId = evt.operator.openId;
  if (!openId) {
    return { toast: { type: 'error', content: '无法识别操作者' } };
  }

  const option = parseVoteAction(evt.action.value);
  if (!option) {
    return { toast: { type: 'info', content: '已收到你的操作' } };
  }

  const { changed, label } = applyPersonVote(dispatched.card, openId, option);
  sealCardState(dispatched.card);
  dispatchedByMessage.set(evt.messageId, dispatched);

  return {
    toast: {
      type: changed ? 'success' : 'info',
      content: changed ? `已投票：${label}` : `你已投给 ${label}`,
    },
    card: { type: 'raw', data: dispatched.card },
  };
}
