import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trace } from '@opentelemetry/api';
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
