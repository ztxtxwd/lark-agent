import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { models, resolveModel } from './llm.js';
import { getTracer, schemaNote } from './tracing.js';

export interface TurnDeps {
  sendPost: (input: { markdown: string }) => Promise<void>;
}

export interface TurnResult {
  delivered: boolean;
  finalText: string;
  aborted: boolean;
}

export function makeTools(deps: TurnDeps, state: { delivered: boolean }): AgentTool[] {
  const parameters = Type.Object({
    content: Type.String({ description: 'Markdown 正文' }),
  });
  return [
    {
      name: 'reply_post',
      label: '回复文本',
      description: '向用户发送文字回复。所有沟通都通过这个工具完成。',
      parameters,
      execute: async (_id, raw) => {
        const params = raw as { content?: unknown };
        const markdown = typeof params.content === 'string' ? params.content : '';
        if (!markdown.trim()) throw new Error('content 不能为空');
        await deps.sendPost({ markdown });
        state.delivered = true;
        return { content: [{ type: 'text', text: '文本已发送。' }], details: {}, terminate: true };
      },
    },
  ];
}

export async function runAgentTurn(
  systemPrompt: string,
  userPrompt: string,
  deps: TurnDeps,
  signal?: AbortSignal,
): Promise<TurnResult> {
  const state = { delivered: false };
  const tools = makeTools(deps, state);

  return getTracer().startActiveSpan('agent.turn', async (span) => {
    try {
      if (signal?.aborted) {
        span.setAttribute('lark_agent.aborted', true);
        return { delivered: false, finalText: '', aborted: true };
      }

      const model = resolveModel();
      const agent = new Agent({
        initialState: {
          systemPrompt: `${systemPrompt}\n\n${schemaNote}`,
          model,
          tools,
        },
        streamFn: models.streamSimple.bind(models),
      });

      const onAbort = () => agent.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      let finalText = '';
      try {
        if (!signal?.aborted) await agent.prompt(userPrompt);
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
      return { delivered: state.delivered, finalText, aborted };
    } finally {
      span.end();
    }
  });
}
