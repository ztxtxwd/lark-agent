import type lark from '@larksuiteoapi/node-sdk';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRawCardEnvelope, rawCardToDsl, rawToDsl, normalizeStoredCardColors, createColorRegistry } from '@open-feishu-card/adapter';
import { parsePostContent, parseTextContent } from './history.js';
import { lint } from '@open-feishu-card/linter';
import { FeishuCardV2Schema } from '@open-feishu-card/schema';
import { validate } from '@open-feishu-card/validator';

export interface CardCheckResult {
  /** Schema 净化后的卡片（可直接发给飞书） */
  card?: Record<string, unknown>;
  errors: string[];
  hints: string[];
}

/** 相对亮度（0–1）；用于判断 cus-accent 是否被建成了浅色底而不是字色。 */
function rgbaRelativeLuminance(rgba: string): number | undefined {
  const m = rgba.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return undefined;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/**
 * adapter 的 normalizeStoredCardColors 会把「无 <font> 的加粗 markdown」包成 cus-accent，
 * 而 cus-accent 又常被建成第一块浅色背景。发送/改卡时就会把正文染成浅色。
 * 发送前若 accent 过浅，改成已有字色（cus-text-0）或近黑 ink。
 */
function ensureCusAccentIsReadableTextColor(dsl: Record<string, unknown>): void {
  const config = dsl.config;
  if (!isRecord(config)) return;
  const style = config.style;
  if (!isRecord(style)) return;
  const color = style.color;
  if (!isRecord(color)) return;

  const accent = color['cus-accent'];
  if (!isRecord(accent) || typeof accent.light_mode !== 'string') return;
  const lum = rgbaRelativeLuminance(accent.light_mode);
  if (lum === undefined || lum < 0.72) return;

  const ink =
    isRecord(color['cus-text-0']) && typeof color['cus-text-0'].light_mode === 'string'
      ? color['cus-text-0']
      : undefined;

  color['cus-accent'] = {
    light_mode: typeof ink?.light_mode === 'string' ? ink.light_mode : 'rgba(31,35,41,1)',
    dark_mode:
      typeof ink?.dark_mode === 'string'
        ? ink.dark_mode
        : typeof ink?.light_mode === 'string'
          ? ink.light_mode
          : 'rgba(31,35,41,1)',
  };
}

/** 飞书 raw 回读才会带 custom_background_style；自有 DSL / 已还原底稿没有。 */
function hasFeishuExpandedCustomColors(dsl: Record<string, unknown>): boolean {
  let found = false;
  const walk = (node: unknown): void => {
    if (found) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isRecord(node)) return;
    if (node.custom_background_style || node.custom_border_color || node.customBorderColor) {
      found = true;
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(dsl.body);
  return found;
}

/**
 * 回读飞书卡：完整 normalize（含缺字色补全）。
 * 自有 DSL / 已是 cus-* 底稿：跳过「给所有 ** 包 cus-accent」，避免改卡时颜色被重写。
 */
function normalizeCardColors(dsl: Record<string, unknown>): void {
  ensureCusAccentIsReadableTextColor(dsl);
  if (hasFeishuExpandedCustomColors(dsl)) {
    normalizeStoredCardColors(dsl);
  } else {
    normalizeStoredCardColors(dsl, createColorRegistry());
  }
  ensureCusAccentIsReadableTextColor(dsl);
}

/** get_message_detail 返回内容的上限；超出部分截断并标注。 */
const DETAIL_MAX_CHARS = 16_000;

function truncateDetail(text: string): string {
  return text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS)}\n…(已截断)` : text;
}

/** 单个元素的摘要文案里保留的最大字符数。 */
const OUTLINE_SNIPPET_CHARS = 60;

/**
 * 行首无序列表标记（- * •），后接可选的加粗符，再紧跟 emoji。
 * emoji 本身就是项目符号，再渲染出圆点就是双重符号，需把标记去掉。
 */
const EMOJI_LIST_LINE = /^[ \t]*[-*•][ \t]+(?=\*{0,2}\p{Extended_Pictographic})/u;

/** 去掉以 emoji 开头的列表项行首的无序列表标记（保留 emoji 与加粗，\n 换行保持每行独立）。 */
function stripEmojiListMarkers(content: string): string {
  return content
    .split('\n')
    .map((line) => line.replace(EMOJI_LIST_LINE, ''))
    .join('\n');
}

/** 递归归一化所有 markdown 元素：emoji 开头的列表项不再叠加无序列表圆点。 */
function normalizeEmojiListMarkers(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) normalizeEmojiListMarkers(child);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj.tag === 'markdown' && typeof obj.content === 'string') {
    obj.content = stripEmojiListMarkers(obj.content);
  }
  for (const value of Object.values(obj)) normalizeEmojiListMarkers(value);
}

/** 去掉 markdown/富文本标记，压成一行纯文本摘要。 */
function flattenMd(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/[*`#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, OUTLINE_SNIPPET_CHARS);
}

/** 元素首个文本内容的摘要；取不到返回空串。容器型元素（column 等）递归取第一个子元素。 */
function firstText(el: unknown): string {
  if (!el || typeof el !== 'object') return '';
  const e = el as Record<string, unknown>;
  if (typeof e.content === 'string') return flattenMd(e.content);
  if (e.text && typeof e.text === 'object') {
    const c = (e.text as Record<string, unknown>).content;
    if (typeof c === 'string') return flattenMd(c);
  }
  if (Array.isArray(e.elements) && e.elements.length > 0) return firstText(e.elements[0]);
  return '';
}

/** 一行索引摘要：tag + 内容预览，让模型不必通读整卡 JSON 就能对上下标。 */
function summarizeElement(el: unknown): string {
  if (!el || typeof el !== 'object') return String(el);
  const e = el as Record<string, unknown>;
  const tag = typeof e.tag === 'string' ? e.tag : '未知';
  switch (tag) {
    case 'hr':
      return 'hr';
    case 'img':
      return 'img';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'column_set': {
      const cols = Array.isArray(e.columns) ? (e.columns as unknown[]) : [];
      const heads = cols.map((c) => firstText(c) || '…');
      return `column_set(${cols.length}列) — ${heads.join(' | ')}`;
    }
    case 'interactive_container': {
      const els = Array.isArray(e.elements) ? (e.elements as unknown[]) : [];
      return `interactive_container — ${firstText(els[0]) || '…'}`;
    }
    default:
      return `${tag} — ${firstText(el) || '…'}`;
  }
}

/**
 * body.elements 索引表。模型手数嵌套 JSON 的数组下标极易出错
 * （真实案例：想把末尾 /13 的结论块换成强调框，却 replace 了 /9 的 hr），
 * 因此把每个顶层元素的下标+摘要直接列出来，modify_card 的 /body/elements/N 以此为准。
 */
export function buildElementOutline(dsl: unknown): string {
  if (!dsl || typeof dsl !== 'object') return '';
  const body = (dsl as Record<string, unknown>).body;
  const elements = body && typeof body === 'object' ? (body as Record<string, unknown>).elements : undefined;
  if (!Array.isArray(elements) || elements.length === 0) return '';
  const lines = elements.map((el, i) => `${i}: ${summarizeElement(el)}`);
  return (
    `[body.elements 索引]（共 ${elements.length} 个；modify_card 的 /body/elements/<N> 中 N 以下表为准）\n` +
    lines.join('\n')
  );
}

/**
 * 把卡片 DSL 存成本机底稿文件，供 modify_card 引用（修改+发送一步完成），
 * 模型无需在回复里重复输出整卡 JSON。
 */
async function saveCardDraftFile(messageId: string, dslText: string): Promise<string> {
  const dir = join(tmpdir(), 'lark-agent', 'cards');
  await fs.mkdir(dir, { recursive: true });
  const safe = messageId.replace(/[^A-Za-z0-9_-]/g, '_');
  const path = join(dir, `${safe}.json`);
  await fs.writeFile(path, dslText);
  return path;
}

function fetchMediaMessageDetail(
  messageId: string,
  msgType: string,
  content: string | undefined,
): string {
  let fileName: string | undefined;
  try {
    const parsed = JSON.parse(content ?? '') as { file_name?: unknown };
    if (typeof parsed.file_name === 'string') fileName = parsed.file_name;
  } catch {
    // ignore
  }
  const label =
    msgType === 'file'
      ? `[文件${fileName ? `：${fileName}` : ''}]（内容未内联）`
      : `[${msgType}${fileName ? `：${fileName}` : ''}]`;
  return truncateDetail(`[消息 ${messageId} 详情]\n${label}`);
}

/** 模型常把 duration_ms 抄到组件上；飞书会拒绝，发送前剥离。 */
export function stripIllegalMediaDurationFields(cardDsl: unknown): number {
  let stripped = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'audio' || obj.tag === 'video') {
      if ('duration_ms' in obj) {
        delete obj.duration_ms;
        stripped += 1;
      }
      if ('duration' in obj) {
        delete obj.duration;
        stripped += 1;
      }
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(cardDsl);
  return stripped;
}

function lintCardMedia(dsl: Record<string, unknown>): string[] {
  const errors: string[] = [];
  let audioOrVideoCount = 0;
  let mediaMissingFileKey = 0;
  let mediaIllegalDuration = 0;

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'audio' || obj.tag === 'video') {
      audioOrVideoCount += 1;
      if (typeof obj.file_key !== 'string' || !obj.file_key.trim()) mediaMissingFileKey += 1;
      if ('duration_ms' in obj || 'duration' in obj) mediaIllegalDuration += 1;
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(dsl);

  if (audioOrVideoCount > 0) {
    const config = dsl.config;
    const enableForward =
      config && typeof config === 'object'
        ? (config as Record<string, unknown>).enable_forward
        : undefined;
    if (enableForward !== false) {
      errors.push(
        '卡片含 audio/video 组件时必须设置 config.enable_forward 为 false（飞书否则拒绝发送）',
      );
    }
  }
  if (mediaMissingFileKey > 0) {
    errors.push(
      `${mediaMissingFileKey} 个 audio/video 组件缺少 file_key；请用 get_message_detail 返回的 card_media.file_key（不要用 source_file_key）`,
    );
  }
  if (mediaIllegalDuration > 0) {
    errors.push(
      `${mediaIllegalDuration} 个 audio/video 组件含非法 duration/duration_ms 字段（时长仅在上传时设置，组件 JSON 里不要写）`,
    );
  }
  return errors;
}

/** collapsible_panel 误用 interactive_container 边框字段时拦截发送（否则 schema strip 后边框静默丢失）。 */
function lintCollapsiblePanelProps(dsl: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'collapsible_panel') {
      const bad: string[] = [];
      if ('has_border' in obj) bad.push('has_border');
      if ('border_color' in obj) bad.push('border_color');
      if ('corner_radius' in obj) bad.push('corner_radius');
      if ('background_style' in obj) bad.push('background_style');
      if (bad.length > 0) {
        errors.push(
          `collapsible_panel 不能用 interactive_container 字段（${bad.join('、')}）；边框写 border:{"color":"…","corner_radius":"…"}，背景写 background_color`,
        );
      }
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(dsl);
  return errors;
}

/**
 * 改卡上下文：完整 schema 2.0 DSL + elements 索引 + 底稿路径。
 * 复杂卡片只靠标题/索引不够写叶子 patch，必须把全文一次交给模型。
 */
export function formatCardDraftBrief(
  messageId: string,
  dsl: Record<string, unknown>,
  draftPath: string,
): string {
  const outline = buildElementOutline(dsl);
  const dslText = JSON.stringify(dsl, null, 2);
  const parts = [`[消息 ${messageId} 详情]`, dslText];
  if (outline) parts.push('', outline);
  parts.push(
    '',
    `[底稿文件]`,
    draftPath,
    `（modify_card 的 path 用此路径。完整 DSL 已在上方，勿再调 get_message_detail）`,
  );
  return parts.join('\n');
}

/** 拉取卡片完整 DSL、落底稿，注入改卡上下文。 */
export async function prepareCardReplyContext(
  client: lark.Client,
  messageId: string,
): Promise<{ brief: string }> {
  const dsl = await fetchCardDsl(client, messageId);
  const dslText = JSON.stringify(dsl, null, 2);
  const draftPath = await saveCardDraftFile(messageId, dslText);
  return { brief: formatCardDraftBrief(messageId, dsl, draftPath) };
}

function parseInteractiveCardDsl(
  content: string | undefined,
  messageId: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content ?? '');
  } catch {
    throw new Error(`消息 ${messageId} 的卡片内容解析失败`);
  }
  const rawDsl = envelopeToDsl(parsed);
  if (!rawDsl) throw new Error(`消息 ${messageId} 不是一张可处理的飞书卡片`);
  const dsl = rawDsl as Record<string, unknown>;
  normalizeCardColors(dsl);
  return dsl;
}

/** Fetch schema-2.0 card DSL from an interactive message. */
export async function fetchCardDsl(
  client: lark.Client,
  messageId: string,
): Promise<Record<string, unknown>> {
  const res = await client.im.message.get({
    path: { message_id: messageId },
    params: {
      card_msg_content_type: 'raw_card_content' as 'user_card_content',
    },
  });
  const item = res.data?.items?.[0];
  if (!item) throw new Error(`未找到消息 ${messageId}`);
  if (item.msg_type !== 'interactive') {
    throw new Error(`消息 ${messageId} 不是一张飞书卡片`);
  }
  return parseInteractiveCardDsl(item.body?.content, messageId);
}

/**
 * Fetch one message's full content for the agent's get_message_detail tool.
 *
 * 卡片取 raw_card_content 并投影为公开的 schema-2.0 DSL（user_card_content 会丢字段）；
 * 文本/post 解包为可读正文；音视频自动转 OPUS/MP4、上传并返回 file_key + local_path。
 */
export async function fetchMessageDetail(
  client: lark.Client,
  messageId: string,
): Promise<string> {
  const res = await client.im.message.get({
    path: { message_id: messageId },
    params: {
      card_msg_content_type: 'raw_card_content' as 'user_card_content',
    },
  });
  const item = res.data?.items?.[0];
  if (!item) throw new Error(`未找到消息 ${messageId}`);

  switch (item.msg_type) {
    case 'interactive': {
      const dsl = parseInteractiveCardDsl(item.body?.content, messageId);
      const dslText = JSON.stringify(dsl, null, 2);
      const draftPath = await saveCardDraftFile(messageId, dslText);
      return formatCardDraftBrief(messageId, dsl, draftPath);
    }
    case 'text':
      return truncateDetail(parseTextContent(item.body?.content));
    case 'post':
      return truncateDetail(parsePostContent(item.body?.content));
    case 'image':
      return '[图片]（二进制内容不在消息里）';
    case 'audio':
    case 'media':
    case 'video':
    case 'file':
      return fetchMediaMessageDetail(messageId, item.msg_type ?? '', item.body?.content);
    default:
      return item.body?.content ? truncateDetail(item.body.content) : `[${item.msg_type ?? '未知类型'}]`;
  }
}

/** 从卡片 JSON 提取 config.summary.content（聊天栏预览摘要）。 */
export function extractCardSummary(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    const dsl = envelopeToDsl(parsed);
    if (!dsl) return extractSummaryFromConfig((parsed as Record<string, unknown>).config);
    return extractSummaryFromConfig(dsl.config);
  } catch {
    return '';
  }
}

function extractSummaryFromConfig(config: unknown): string {
  if (!config || typeof config !== 'object') return '';
  const summary = (config as Record<string, unknown>).summary;
  if (!summary || typeof summary !== 'object') return '';
  const s = summary as { content?: unknown; i18n_content?: Record<string, unknown> };
  if (typeof s.content === 'string' && s.content.trim()) return s.content.trim();
  const i18n = s.i18n_content;
  if (i18n && typeof i18n === 'object') {
    for (const key of ['zh_cn', 'en_us']) {
      const v = i18n[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    for (const v of Object.values(i18n)) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return '';
}

function envelopeToDsl(parsed: unknown): Record<string, unknown> | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  // 已经是公开 schema-2.0 DSL（如我们自己发出的卡片，发送时原样存储）则透传；
  // 只有 raw/envelope 形态才走 adapter 投影。rawToDsl 对纯 v2 输入会丢 header 等字段。
  const p = parsed as Record<string, unknown>;
  if (!('json_card' in p) && p.schema === '2.0') return p;
  const dsl = isRawCardEnvelope(parsed) ? rawCardToDsl(parsed) : rawToDsl(parsed);
  if (!dsl || typeof dsl !== 'object' || Array.isArray(dsl)) return undefined;
  return dsl as Record<string, unknown>;
}

const HTTPS_FALLBACK_URL = 'https://example.com';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 发送前自动修补常见可安全推断的 schema 缺口，减少模型重试轮次。 */
export function autoFixCardDsl(root: Record<string, unknown>): void {
  const walk = (node: unknown, inForm: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inForm);
      return;
    }
    if (!isRecord(node)) return;

    const tag = typeof node.tag === 'string' ? node.tag : '';
    const insideForm = inForm || tag === 'form';

    if (tag === 'img' && !node.alt) {
      node.alt = { tag: 'plain_text', content: 'image' };
    }

    if ((tag === 'interactive_container' || tag === 'button') && !insideForm && !('behaviors' in node)) {
      if (tag === 'button') {
        node.behaviors = [
          {
            type: 'open_url',
            default_url: HTTPS_FALLBACK_URL,
            pc_url: HTTPS_FALLBACK_URL,
            ios_url: HTTPS_FALLBACK_URL,
            android_url: HTTPS_FALLBACK_URL,
          },
        ];
      } else if (node.disabled !== true) {
        node.behaviors = [];
      }
    }

    if (Array.isArray(node.behaviors)) {
      for (const behavior of node.behaviors) {
        if (!isRecord(behavior) || behavior.type !== 'open_url') continue;
        const defaultUrl =
          typeof behavior.default_url === 'string' && behavior.default_url.trim()
            ? behavior.default_url.trim()
            : undefined;
        if (defaultUrl) continue;
        const pc =
          typeof behavior.pc_url === 'string' && behavior.pc_url.startsWith('https://')
            ? behavior.pc_url
            : HTTPS_FALLBACK_URL;
        behavior.default_url = pc;
      }
    }

    const childInForm = insideForm;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value, childInForm);
    }
  };
  walk(root, false);
}

/** 校验/发送失败时的统一文案；reply_card 场景引导改走 modify_card 叶子 patch。 */
export function formatCardDeliveryError(
  result: CardCheckResult,
  tool?: 'reply_card' | 'modify_card',
): string {
  const errors =
    result.errors.length > 0 ? result.errors : ['未知校验失败'];
  const hints = [...result.hints];

  if (tool === 'reply_card') {
    hints.push(
      '若上下文已有 [底稿文件]，请改用 modify_card，仅 patch 校验失败的叶子字段（如 …/behaviors、…/alt、…/default_url），禁止用 reply_card 重发整卡',
    );
  } else if (tool === 'modify_card') {
    hints.push(
      '请缩小 json_patch：只对报错路径做 replace/add，勿 replace 整块 /body/elements/<N>，勿改用 reply_card 重发整卡',
    );
  }

  const hint = hints.length > 0 ? `。建议：${hints.join('；')}` : '';
  return `卡片未通过 schema 2.0 检查：${errors.join('；')}${hint}`;
}

/** Schema 2.0 校验：错误拦截发送；linter 仅作建议。成功时返回剥离未知字段后的卡片。 */
export function checkCardDsl(input: unknown): CardCheckResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: ['卡片必须是 JSON 对象'], hints: [] };
  }

  // 风格归一化在深拷贝上进行，不影响调用方对象；校验与发送都用归一化后的卡片。
  const dsl = structuredClone(input) as Record<string, unknown>;
  normalizeCardColors(dsl);
  normalizeEmojiListMarkers(dsl);
  stripIllegalMediaDurationFields(dsl);
  autoFixCardDsl(dsl);

  const source = JSON.stringify(dsl, null, 2);
  const errors: string[] = [...lintCardMedia(dsl), ...lintCollapsiblePanelProps(dsl)];
  const hints: string[] = [];

  for (const d of validate(source)) {
    const loc = d.path && d.path !== '/' ? `${d.path}: ` : '';
    const line = `${loc}${d.message}`;
    if (d.severity === 'error' || d.code === 'deprecated-prop') errors.push(line);
    else hints.push(line);
  }

  for (const d of lint(source)) {
    hints.push(`${d.rule}: ${d.message}`);
  }

  if (errors.length > 0) return { errors, hints };

  const parsed = FeishuCardV2Schema.safeParse(dsl);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map((i) => {
        const path = i.path.length > 0 ? `/${i.path.join('/')}: ` : '';
        return `${path}${i.message}`;
      }),
      hints,
    };
  }
  return { card: parsed.data as Record<string, unknown>, errors: [], hints };
}
