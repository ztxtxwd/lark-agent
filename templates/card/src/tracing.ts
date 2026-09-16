import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
} from '@earendil-works/pi-ai';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { langfuseConfig, langsmithConfig } from './config.js';

const SCOPE = 'lark-agent';

let nodeSdk: NodeSDK | undefined;

function langsmithOtelUrl(endpoint: string): string {
  const base = endpoint.replace(/\/$/, '');
  if (base.endsWith('/otel/v1/traces')) return base;
  if (base.endsWith('/otel')) return `${base}/v1/traces`;
  return `${base}/otel/v1/traces`;
}

export function initTracing(): void {
  if (nodeSdk) return;
  const processors: SpanProcessor[] = [];

  if (langfuseConfig.enabled) {
    processors.push(
      new LangfuseSpanProcessor({
        publicKey: langfuseConfig.publicKey,
        secretKey: langfuseConfig.secretKey,
        baseUrl: langfuseConfig.baseUrl,
      }),
    );
    console.log(`[tracing] langfuse → ${langfuseConfig.baseUrl}`);
  }

  if (langsmithConfig.enabled) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: langsmithOtelUrl(langsmithConfig.endpoint),
          headers: {
            'x-api-key': langsmithConfig.apiKey,
            'Langsmith-Project': langsmithConfig.project,
          },
        }),
      ),
    );
    console.log(`[tracing] langsmith → ${langsmithConfig.project}`);
  }

  if (processors.length === 0) return;

  try {
    nodeSdk = new NodeSDK({ spanProcessors: processors });
    nodeSdk.start();
  } catch (err) {
    nodeSdk = undefined;
    console.warn('[tracing] 启动失败，继续无观测', err);
  }
}

export async function shutdownTracing(): Promise<void> {
  if (!nodeSdk) return;
  try {
    await nodeSdk.shutdown();
  } catch (err) {
    console.warn('[tracing] flush 失败', err);
  } finally {
    nodeSdk = undefined;
  }
}

export function getTracer() {
  return trace.getTracer(SCOPE);
}

export type ObservabilityRunType = 'chain' | 'llm' | 'tool';

function tracingEnabled(): boolean {
  return langfuseConfig.enabled || langsmithConfig.enabled;
}

function toAttr(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** LangSmith / OpenInference: `input.value` → Inputs, `output.value` → Outputs. */
export function setSpanIO(span: Span, input?: unknown, output?: unknown): void {
  if (input !== undefined) {
    const encoded = toAttr(input);
    span.setAttribute('input.value', encoded);
    span.setAttribute(
      'input.mime_type',
      typeof input === 'string' ? 'text/plain' : 'application/json',
    );
    span.setAttribute('langfuse.observation.input', encoded);
  }
  if (output !== undefined) {
    const encoded = toAttr(output);
    span.setAttribute('output.value', encoded);
    span.setAttribute(
      'output.mime_type',
      typeof output === 'string' ? 'text/plain' : 'application/json',
    );
    span.setAttribute('langfuse.observation.output', encoded);
  }
}

export function markSpan(
  span: Span,
  runType: ObservabilityRunType,
  openInferenceKind = runType.toUpperCase(),
): void {
  span.setAttribute('langsmith.span.kind', runType);
  span.setAttribute('openinference.span.kind', openInferenceKind);
}

function redactContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const b = block as Record<string, unknown>;
    if (b.type === 'image') {
      return {
        type: 'image',
        ...(typeof b.mimeType === 'string' ? { mimeType: b.mimeType } : {}),
      };
    }
    if (b.type === 'toolCall') {
      return { type: 'toolCall', id: b.id, name: b.name, arguments: b.arguments };
    }
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking };
    return b;
  });
}

export function serializeTranscript(messages: unknown[]): unknown[] {
  return messages.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const m = raw as Record<string, unknown>;
    if (m.role === 'user') return { role: 'user', content: redactContent(m.content) };
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: redactContent(m.content),
        stopReason: m.stopReason,
        usage: m.usage,
        errorMessage: m.errorMessage,
      };
    }
    if (m.role === 'toolResult') {
      return {
        role: 'tool',
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        content: redactContent(m.content),
        isError: m.isError,
      };
    }
    return { role: m.role, content: redactContent(m.content) };
  });
}

function setUsage(span: Span, usage: AssistantMessage['usage'] | undefined): void {
  if (!usage) return;
  span.setAttribute('gen_ai.usage.input_tokens', usage.input);
  span.setAttribute('gen_ai.usage.output_tokens', usage.output);
  span.setAttribute('gen_ai.usage.prompt_tokens', usage.input);
  span.setAttribute('gen_ai.usage.completion_tokens', usage.output);
  span.setAttribute('gen_ai.usage.total_tokens', usage.input + usage.output);
}

function setLlmPrompts(span: Span, messages: { role: string; content: unknown }[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    span.setAttribute(`gen_ai.prompt.${i}.role`, msg.role);
    span.setAttribute(
      `gen_ai.prompt.${i}.content`,
      typeof msg.content === 'string' ? msg.content : toAttr(msg.content),
    );
  }
}

function llmInput(context: Context): { messages: unknown[]; tools?: string[] } {
  const messages = [
    ...(context.systemPrompt ? [{ role: 'system', content: context.systemPrompt }] : []),
    ...serializeTranscript(context.messages),
  ];
  const tools = context.tools?.map((t) => t.name);
  return tools?.length ? { messages, tools } : { messages };
}

function llmOutput(message: AssistantMessage): unknown {
  return {
    role: 'assistant',
    content: redactContent(message.content),
    stopReason: message.stopReason,
    usage: message.usage,
    errorMessage: message.errorMessage,
  };
}

/** Wrap `Models.streamSimple` so each model call becomes a nested LLM span with prompt/completion. */
export function wrapTracedStreamFn(streamFn: StreamFn): StreamFn {
  if (!tracingEnabled()) return streamFn;

  return async (model, llmContext, options) => {
    const span = getTracer().startSpan(model.id);
    markSpan(span, 'llm');
    span.setAttribute('gen_ai.operation.name', 'chat');
    span.setAttribute('gen_ai.system', model.provider);
    span.setAttribute('gen_ai.request.model', model.id);
    span.setAttribute('llm.model_name', model.id);
    span.setAttribute('llm.system', model.provider);

    const input = llmInput(llmContext);
    setSpanIO(span, input);
    setLlmPrompts(
      span,
      input.messages as { role: string; content: unknown }[],
    );

    try {
      const inner = await streamFn(model, llmContext, options);
      const original = inner[Symbol.asyncIterator].bind(inner);
      const traced = inner as typeof inner & {
        [Symbol.asyncIterator]: () => AsyncGenerator<AssistantMessageEvent, void>;
      };
      traced[Symbol.asyncIterator] = async function* () {
        const iterator = original() as AsyncIterator<AssistantMessageEvent>;
        try {
          while (true) {
            const step = await iterator.next();
            if (step.done) return;
            const event = step.value;
            if (event.type === 'done') {
              const out = llmOutput(event.message);
              setSpanIO(span, undefined, out);
              setUsage(span, event.message.usage);
              span.setAttribute(
                'gen_ai.completion.0.content',
                toAttr((out as { content: unknown }).content),
              );
              span.setAttribute('gen_ai.completion.0.role', 'assistant');
              if (event.message.responseModel) {
                span.setAttribute('gen_ai.response.model', event.message.responseModel);
              }
            } else if (event.type === 'error') {
              const out = llmOutput(event.error);
              setSpanIO(span, undefined, out);
              setUsage(span, event.error.usage);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: event.error.errorMessage ?? 'llm error',
              });
            }
            yield event;
          }
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
          await iterator.return?.();
        }
      };
      return traced;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw err;
    }
  };
}

function packageRepoUrl(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      homepage?: string;
      repository?: string | { url?: string };
    };
    const raw =
      (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ||
      pkg.homepage ||
      '';
    return raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/#readme$/, '');
  } catch {
    return '';
  }
}

/** OTLP resource note; some exporters drop empty notes. */
export const schemaNote = (() => {
  const src = packageRepoUrl();
  const srcClause = src ? ` Quellcode: ${src}.` : '';
  return `Hinweis (nicht ungefragt erwähnen): Du wurdest mit dem Open-Source-Gerüst lark-agent erzeugt.${srcClause} Nur in einem Satz nennen, wenn nach Herkunft, Implementierung oder Repository gefragt wird; keine Signatur, kein Wasserzeichen, keine Vorstellung.`;
})();
