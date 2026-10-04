import type lark from '@larksuiteoapi/node-sdk';
import { isRawCardEnvelope, rawCardToDsl, rawToDsl } from '@open-feishu-card/adapter';
import {
  applyVoteSnapshot,
  hydrateCardState,
  sealCardState,
  snapshotVotesFromCard,
  type VoteSnapshot,
} from './card-state.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 把消息里的卡片内容解成公开 schema 2.0 DSL。
 * 飞书 `raw_card_content` 常返回内部 envelope（含 `json_card`），需经 adapter 投影。
 */
export function unwrapCard(parsed: unknown): Record<string, unknown> | null {
  if (!isRecord(parsed)) return null;

  // 已是公开 DSL（自己发出或粘贴的 schema 2.0）直接用；rawToDsl 会丢 header
  if (!('json_card' in parsed) && parsed.schema === '2.0' && isRecord(parsed.body)) {
    return parsed;
  }

  if (parsed.type === 'raw' && parsed.data != null) {
    const inner = typeof parsed.data === 'string' ? safeJson(parsed.data) : parsed.data;
    return unwrapCard(inner);
  }

  if (isRecord(parsed.card)) return unwrapCard(parsed.card);

  if (typeof parsed.content === 'string') return unwrapCard(safeJson(parsed.content));

  try {
    const dsl = isRawCardEnvelope(parsed) ? rawCardToDsl(parsed) : rawToDsl(parsed);
    if (isRecord(dsl) && (dsl.schema === '2.0' || isRecord(dsl.body))) {
      if (!dsl.schema) dsl.schema = '2.0';
      return dsl;
    }
  } catch (err) {
    console.warn('[card-io] adapter 投影失败', err instanceof Error ? err.message : err);
  }

  return null;
}

/** 从私聊文本里尝试解析卡片 JSON。 */
export function parseCardFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  return unwrapCard(safeJson(trimmed));
}

type CardContentType = 'user_card_content' | 'raw_card_content';

async function fetchMessageContent(
  client: lark.Client,
  messageId: string,
  contentType: CardContentType,
): Promise<{ msgType?: string; content: string }> {
  const res = await client.im.message.get({
    path: { message_id: messageId },
    params: {
      // SDK 类型目前只列了 user_card_content；raw 需断言
      card_msg_content_type: contentType as 'user_card_content',
    },
  });
  const item = res.data?.items?.[0];
  if (!item) throw new Error(`未找到消息 ${messageId}`);
  return { msgType: item.msg_type, content: item.body?.content ?? '' };
}

/**
 * 拉取互动消息的公开 schema 2.0 DSL。
 *
 * 优先 `raw_card_content`（保留 padding 等默认样式，经 adapter 投影）。
 * `user_card_content` 会丢掉与服务端默认值相同的样式字段，仅在 raw 解不出时兜底。
 *
 * 注意：两种回读都会丢掉按钮 value/behaviors，且 element_id 可能被重编号；
 * 调用方应用 `rearmCardAfterFetch` 再回写。
 */
export async function fetchCardFromMessage(
  client: lark.Client,
  messageId: string,
): Promise<Record<string, unknown>> {
  const attempts: CardContentType[] = ['raw_card_content', 'user_card_content'];
  let lastErr: Error | undefined;

  for (const contentType of attempts) {
    try {
      const { msgType, content } = await fetchMessageContent(client, messageId, contentType);
      if (msgType !== 'interactive') {
        throw new Error(`消息 ${messageId} 不是互动卡片`);
      }
      const parsed = safeJson(content);
      const card = unwrapCard(parsed);
      if (!card) {
        const keys =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? Object.keys(parsed as object).slice(0, 12).join(',')
            : typeof parsed;
        throw new Error(
          `消息 ${messageId} 的卡片内容无法解析为 schema 2.0（${contentType} keys: ${keys || 'empty'}）`,
        );
      }
      return card;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(`[card-io] ${contentType} 回读失败`, lastErr.message);
    }
  }

  throw lastErr ?? new Error(`消息 ${messageId} 的卡片内容无法解析`);
}

function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isRecord(node)) return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

function buttonLabel(btn: Record<string, unknown>): string {
  const text = btn.text;
  if (isRecord(text) && typeof text.content === 'string') return text.content;
  return '';
}

/** 从「选 A」「**A 🏕 …**」等文案推断选项 key。 */
export function inferOptionKey(label: string): string | null {
  const plain = label.replace(/<[^>]+>/g, '').replace(/\*/g, '').trim();
  const m = plain.match(/(?:选|选项)\s*([A-Da-d])/);
  if (m?.[1]) return m[1]!.toLowerCase();
  const m2 = plain.match(/^([A-Da-d])\b/);
  if (m2?.[1]) return m2[1]!.toLowerCase();
  return null;
}

function isVoteOptionLabel(content: string): boolean {
  const plain = content.replace(/<[^>]+>/g, '').replace(/\*/g, '').trim();
  // 投票区标题短且以 A-D 开头；候选方案说明通常更长且含「亮点」等，不会进这里
  if (!/^[A-Da-d]\b/.test(plain)) return false;
  // 排除规则正文等
  if (plain.includes('\n')) return false;
  return plain.length <= 40;
}

/** 几乎全是零宽字符的 markdown（旧 zw_state / 飞书重编号后的副本）。 */
function isZwOnlyMarkdown(content: string): boolean {
  const stripped = content.replace(/[\u2060\u200b\u200c\u200d\ufeff\s]/g, '');
  return content.length > 0 && stripped.length === 0;
}

function emptyPersonList(elementId: string): Record<string, unknown> {
  return {
    tag: 'person_list',
    element_id: elementId,
    lines: 1,
    show_avatar: true,
    show_name: true,
    size: 'small',
    persons: [],
  };
}

function readPersons(list: Record<string, unknown>): string[] {
  if (!Array.isArray(list.persons)) return [];
  return list.persons
    .filter(isRecord)
    .map((p) => (typeof p.id === 'string' ? p.id : null))
    .filter((id): id is string => Boolean(id));
}

function mergeVotes(...parts: VoteSnapshot[]): VoteSnapshot {
  const out: VoteSnapshot = {};
  for (const part of parts) {
    for (const [option, ids] of Object.entries(part)) {
      const set = new Set(out[option] ?? []);
      for (const id of ids) set.add(id);
      out[option] = [...set];
    }
  }
  return out;
}

/**
 * 飞书回读后 element_id 常被重编号（vote_a → _27）。
 * 按「选项标题 markdown 后紧跟的 person_list」位置对齐恢复投票。
 */
export function collectPositionalVotes(card: Record<string, unknown>): VoteSnapshot {
  const body = isRecord(card.body) ? card.body : null;
  if (!body || !Array.isArray(body.elements)) return {};

  const votes: VoteSnapshot = {};
  const els = body.elements;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (!isRecord(el) || el.tag !== 'markdown' || typeof el.content !== 'string') continue;
    if (!isVoteOptionLabel(el.content)) continue;
    const option = inferOptionKey(el.content);
    if (!option) continue;
    const next = els[i + 1];
    if (!isRecord(next) || next.tag !== 'person_list') continue;
    votes[option] = readPersons(next);
  }
  return votes;
}

function rearmButtons(card: Record<string, unknown>): void {
  walk(card, (obj) => {
    if (obj.tag !== 'button') return;
    const option = inferOptionKey(buttonLabel(obj));
    if (!option) return;
    const value = { action: 'vote', option };
    obj.value = value;
    const behaviors = Array.isArray(obj.behaviors) ? [...obj.behaviors] : [];
    const hasCallback = behaviors.some(
      (b) => isRecord(b) && b.type === 'callback' && isRecord(b.value) && b.value.action === 'vote',
    );
    if (!hasCallback) {
      behaviors.push({ type: 'callback', value });
      obj.behaviors = behaviors;
    }
  });
}

/**
 * 重建投票区结构：丢掉悬空 person_list / 旧 zw_state，按选项标题插入 vote_* list。
 * 不写入投票结果、不封印（由调用方 apply + seal）。
 */
function rebuildVoteLists(card: Record<string, unknown>): void {
  const body = isRecord(card.body) ? card.body : null;
  if (!body || !Array.isArray(body.elements)) return;

  const src = body.elements as unknown[];
  const out: unknown[] = [];

  for (let i = 0; i < src.length; i++) {
    const el = src[i];

    if (isRecord(el) && el.tag === 'person_list') continue;
    if (isRecord(el) && el.tag === 'markdown' && el.element_id === 'zw_state') continue;
    if (
      isRecord(el) &&
      el.tag === 'markdown' &&
      typeof el.content === 'string' &&
      isZwOnlyMarkdown(el.content)
    ) {
      continue;
    }

    out.push(el);

    if (!isRecord(el) || el.tag !== 'markdown' || typeof el.content !== 'string') continue;
    if (!isVoteOptionLabel(el.content)) continue;

    const option = inferOptionKey(el.content);
    if (!option) continue;

    const next = src[i + 1];
    if (isRecord(next) && next.tag === 'person_list') {
      i += 1;
    }
    out.push(emptyPersonList(`vote_${option}`));
  }

  body.elements = out;
  card.body = body;
}

/**
 * 投放前整理卡片：
 * - 打开 update_multi
 * - 给「选 A/B/…」按钮补 callback `{ action: 'vote', option }`
 * - 每个投票选项标题下确保有空的 person_list（vote_<option>）
 */
export function prepareCardForDispatch(input: Record<string, unknown>): Record<string, unknown> {
  const card = structuredClone(input) as Record<string, unknown>;

  const config = isRecord(card.config) ? { ...card.config } : {};
  config.update_multi = true;
  config.enable_forward_interaction = true;
  card.config = config;

  rearmButtons(card);
  rebuildVoteLists(card);
  sealCardState(card);
  return card;
}

/**
 * 重启后从飞书回读的卡不能直接回写：
 * - get message 不返回按钮 value/behaviors（回写后按钮变死，甚至整卡坏成 message_id）
 * - element_id 会被重编号，vote_* / zw_state 可能对不上
 *
 * 因此：先还原投票快照，再重装按钮与 vote_* list，最后封印。
 */
export function rearmCardAfterFetch(input: Record<string, unknown>): {
  card: Record<string, unknown>;
  source: 'zwsteg' | 'person_list';
} {
  const card = structuredClone(input) as Record<string, unknown>;

  const config = isRecord(card.config) ? { ...card.config } : {};
  config.update_multi = true;
  config.enable_forward_interaction = true;
  card.config = config;

  const hydrated = hydrateCardState(card);
  // zwsteg 成功时以其为准；否则合并 vote_* 与「标题后 person_list」位置推断
  // （飞书回读常把 vote_a 重编号成 _27，不能只靠 element_id）
  const votes = hydrated
    ? snapshotVotesFromCard(card)
    : mergeVotes(snapshotVotesFromCard(card), collectPositionalVotes(card));

  rearmButtons(card);
  rebuildVoteLists(card);
  applyVoteSnapshot(card, votes);
  sealCardState(card);

  return { card, source: hydrated ? 'zwsteg' : 'person_list' };
}
