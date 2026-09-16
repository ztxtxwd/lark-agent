import { promises as fs } from 'node:fs';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type ImageContent } from '@earendil-works/pi-ai';
import { models, reasoningLevel, resolveModel } from './llm.js';
import {
  getTracer,
  markSpan,
  schemaNote,
  serializeTranscript,
  setSpanIO,
  wrapTracedStreamFn,
} from './tracing.js';
import { applyJsonPatch, parseJsonPatch } from './json-patch.js';
import { checkCardDsl, formatCardDeliveryError } from './parent-card.js';

export interface SendMessageOpts {
  replyToMessageId?: string;
}

export interface TurnDeps {
  sendPost: (input: { title?: string; markdown: string } & SendMessageOpts) => Promise<void>;
  sendCard: (dsl: unknown, opts?: SendMessageOpts) => Promise<string>;
  getMessageDetail: (messageId: string) => Promise<string>;
  pinMessage: (messageId: string) => Promise<string>;
  unpinMessage: (messageId: string) => Promise<string>;
}

export interface TurnResult {
  delivered: boolean;
  finalText: string;
  aborted: boolean;
}

async function assertLocalFile(raw: unknown): Promise<string> {
  if (typeof raw !== 'string') throw new Error('path 缺失：必须提供文件的本机绝对路径');
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!cleaned.startsWith('/')) {
    throw new Error(`path 只接受本机文件的绝对路径（以 / 开头），收到：${cleaned}`);
  }
  const resolved = await fs.realpath(cleaned).catch(() => {
    throw new Error(`文件不存在或不可读：${cleaned}`);
  });
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw new Error(`不是常规文件：${resolved}`);
  return resolved;
}

const replyToMessageIdField = Type.Optional(
  Type.String({
    description:
      '可选。飞书「回复」目标 message_id（om_ 开头）。默认省略：消息直接发到会话。仅当需要明确回应哪条消息时再填。',
  }),
);

function sendOptsFromParams(params: Record<string, unknown>): SendMessageOpts {
  const raw = params.reply_to_message_id;
  if (typeof raw !== 'string') return {};
  const id = raw.trim();
  return id ? { replyToMessageId: id } : {};
}

async function validateAndDeliverCard(
  deps: TurnDeps,
  card: Record<string, unknown>,
  sendOpts: SendMessageOpts,
  tool: 'reply_card' | 'modify_card',
): Promise<void> {
  const checked = checkCardDsl(card);
  if (checked.errors.length > 0 || !checked.card) {
    throw new Error(formatCardDeliveryError(checked, tool));
  }
  await deps.sendCard(checked.card, sendOpts);
}

export function makeTools(deps: TurnDeps, state: { delivered: boolean }): AgentTool[] {
  const replyPost = {
    name: 'reply_post',
    label: '回复文本',
    description: '回复文本消息（飞书富文本）。所有纯文字沟通一律使用本工具',
    parameters: Type.Object({
      content: Type.String({ description: 'Markdown 正文' }),
      title: Type.Optional(Type.String({ description: '消息标题，可省略' })),
      reply_to_message_id: replyToMessageIdField,
    }),
    execute: async (_id: string, raw: unknown) => {
      const params = raw as Record<string, unknown>;
      const markdown = typeof params.content === 'string' ? params.content : '';
      if (!markdown.trim()) throw new Error('content 不能为空');
      const title =
        typeof params.title === 'string' && params.title.trim() ? params.title.trim() : undefined;
      await deps.sendPost({ title, markdown, ...sendOptsFromParams(params) });
      state.delivered = true;
      return { content: [{ type: 'text' as const, text: '文本已发送。' }], details: {}, terminate: true };
    },
  };

  const replyCard = {
    name: 'reply_card',
    label: '回复卡片',
    description:
      '向用户发送一张飞书卡片（schema 2.0 JSON）。必须包含 config.summary.content。',
    parameters: Type.Object({
      card_json: Type.String({
        description:
          '完整的飞书卡片 JSON 字符串（schema 2.0）。必须包含 config.summary.content',
      }),
      reply_to_message_id: replyToMessageIdField,
    }),
    execute: async (_id: string, raw: unknown) => {
      const params = raw as Record<string, unknown>;
      let dsl: unknown;
      try {
        dsl = JSON.parse(typeof params.card_json === 'string' ? params.card_json : '');
        if (dsl && typeof dsl === 'object' && 'dsl' in (dsl as Record<string, unknown>)) {
          dsl = (dsl as { dsl: unknown }).dsl;
        }
      } catch {
        throw new Error('card_json 不是合法的 JSON');
      }
      if (!dsl || typeof dsl !== 'object' || Array.isArray(dsl)) {
        throw new Error('card_json 必须是 JSON 对象');
      }
      await validateAndDeliverCard(
        deps,
        dsl as Record<string, unknown>,
        sendOptsFromParams(params),
        'reply_card',
      );
      state.delivered = true;
      return { content: [{ type: 'text' as const, text: '卡片已发送。' }], details: {}, terminate: true };
    },
  };

  const modifyCard = {
    name: 'modify_card',
    label: '修改并发送卡片',
    description:
      '基于卡片底稿文件应用 JSON Patch（RFC 6902）后发送。path 用上下文或 get_message_detail 的「[底稿文件]」路径。' +
      'json_patch 粒度越细越好：只 replace/add 实际变化的叶子字段；组件类型或结构要变时才整块 replace /body/elements/<N>。',
    parameters: Type.Object({
      path: Type.String({ description: '底稿文件的本机绝对路径' }),
      json_patch: Type.String({
        description: 'RFC 6902 JSON Patch 数组的 JSON 字符串',
      }),
      reply_to_message_id: replyToMessageIdField,
    }),
    execute: async (_id: string, raw: unknown) => {
      const params = raw as Record<string, unknown>;
      const absolutePath = await assertLocalFile(params.path);
      const fileRaw = await fs.readFile(absolutePath, 'utf8');
      let base: unknown;
      try {
        base = JSON.parse(fileRaw);
      } catch {
        throw new Error(`底稿文件不是合法 JSON：${absolutePath}`);
      }
      const ops = parseJsonPatch(params.json_patch);
      const doc = applyJsonPatch(base, ops);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('修改后的卡片必须是 JSON 对象');
      }
      await validateAndDeliverCard(
        deps,
        doc as Record<string, unknown>,
        sendOptsFromParams(params),
        'modify_card',
      );
      state.delivered = true;
      return { content: [{ type: 'text' as const, text: '卡片修改已发送。' }], details: {}, terminate: true };
    },
  };

  const getMessageDetail: AgentTool = {
    name: 'get_message_detail',
    label: '获取消息详情',
    description:
      '按 message_id 获取某条聊天消息的完整内容。卡片返回完整 DSL 与「[底稿文件]」路径。只读，不发送。',
    parameters: Type.Object({
      message_id: Type.String({ description: '目标消息的 message_id（om_ 开头）' }),
    }),
    execute: async (_id, raw) => {
      const params = raw as Record<string, unknown>;
      const messageId = typeof params.message_id === 'string' ? params.message_id.trim() : '';
      if (!messageId) throw new Error('message_id 不能为空');
      const text = await deps.getMessageDetail(messageId);
      return { content: [{ type: 'text' as const, text }], details: {} };
    },
  };

  const pinTool: AgentTool = {
    name: 'pin_message',
    label: '记忆消息',
    description:
      '将某条聊天消息 Pin 到当前会话。用户要求「记住」「作为模板」时使用。成功后用 reply_post 确认。',
    parameters: Type.Object({
      message_id: Type.String({ description: '要记忆的消息 message_id' }),
    }),
    execute: async (_id, raw) => {
      const params = raw as Record<string, unknown>;
      const messageId = typeof params.message_id === 'string' ? params.message_id.trim() : '';
      if (!messageId) throw new Error('message_id 不能为空');
      const text = await deps.pinMessage(messageId);
      return { content: [{ type: 'text' as const, text }], details: {} };
    },
  };

  const unpinTool: AgentTool = {
    name: 'unpin_message',
    label: '取消记忆',
    description: '取消某条消息的 Pin。成功后用 reply_post 确认。',
    parameters: Type.Object({
      message_id: Type.String({ description: '要取消记忆的 message_id' }),
    }),
    execute: async (_id, raw) => {
      const params = raw as Record<string, unknown>;
      const messageId = typeof params.message_id === 'string' ? params.message_id.trim() : '';
      if (!messageId) throw new Error('message_id 不能为空');
      const text = await deps.unpinMessage(messageId);
      return { content: [{ type: 'text' as const, text }], details: {} };
    },
  };

  return [replyPost, replyCard, modifyCard, getMessageDetail, pinTool, unpinTool];
}

export async function runAgentTurn(
  systemPrompt: string,
  userPrompt: string,
  deps: TurnDeps,
  signal?: AbortSignal,
  images?: ImageContent[],
): Promise<TurnResult> {
  const state = { delivered: false };
  const tools = makeTools(deps, state);

  return getTracer().startActiveSpan('agent.turn', async (span) => {
    try {
      markSpan(span, 'chain', 'AGENT');
      const fullSystem = `${systemPrompt}\n\n${schemaNote}`;
      setSpanIO(span, {
        messages: [
          { role: 'system', content: fullSystem },
          { role: 'user', content: userPrompt },
        ],
      });

      if (signal?.aborted) {
        span.setAttribute('lark_agent.aborted', true);
        setSpanIO(span, undefined, { delivered: false, aborted: true, output: '' });
        return { delivered: false, finalText: '', aborted: true };
      }

      const model = resolveModel();
      span.setAttribute('gen_ai.request.model', model.id);
      span.setAttribute('llm.model_name', model.id);
      const agent = new Agent({
        initialState: {
          systemPrompt: fullSystem,
          model,
          tools,
          thinkingLevel: reasoningLevel,
        },
        streamFn: wrapTracedStreamFn(models.streamSimple.bind(models)),
      });

      const onAbort = () => agent.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      let finalText = '';
      try {
        if (!signal?.aborted) await agent.prompt(userPrompt, images);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }

      for (let i = agent.state.messages.length - 1; i >= 0; i--) {
        const m = agent.state.messages[i];
        if (!m || m.role !== 'assistant') continue;
        finalText = m.content
          .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        span.setAttribute('gen_ai.usage.input_tokens', m.usage.input);
        span.setAttribute('gen_ai.usage.output_tokens', m.usage.output);
        break;
      }

      const aborted = signal?.aborted === true;
      span.setAttribute('lark_agent.delivered', state.delivered);
      span.setAttribute('lark_agent.aborted', aborted);
      setSpanIO(span, undefined, {
        delivered: state.delivered,
        aborted,
        output: finalText,
        messages: serializeTranscript(
          agent.state.messages.filter((m) => m.role !== 'user'),
        ),
      });
      return { delivered: state.delivered, finalText, aborted };
    } finally {
      span.end();
    }
  });
}
