import type { CliFlags, DomainChoice, TracingChoice } from './types.js';

function take(argv: string[], i: number): { value: string; next: number } | undefined {
  const value = argv[i + 1];
  if (!value || value.startsWith('-')) return undefined;
  return { value, next: i + 2 };
}

function asDomain(raw: string): DomainChoice | undefined {
  if (raw === 'feishu' || raw === 'lark') return raw;
  return undefined;
}

function asTracing(raw: string): TracingChoice | undefined {
  if (raw === 'none' || raw === 'langfuse' || raw === 'langsmith' || raw === 'both') return raw;
  return undefined;
}

/** 解析 `create-lark-agent [项目名] [flags]`。位置参数同时作为项目名和目录。 */
export function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) {
      if (flags.directory) throw new Error(`多余参数：${arg}`);
      flags.directory = arg;
      i += 1;
      continue;
    }

    const pair = take(argv, i);
    switch (arg) {
      case '-y':
      case '--yes':
        flags.yes = true;
        i += 1;
        break;
      case '--no-install':
        flags.install = false;
        i += 1;
        break;
      case '--install':
        flags.install = true;
        i += 1;
        break;
      case '--name':
        if (!pair) throw new Error('--name 需要一个值');
        flags.name = pair.value;
        i = pair.next;
        break;
      case '--bot-name':
        if (!pair) throw new Error('--bot-name 需要一个值');
        flags.botName = pair.value;
        i = pair.next;
        break;
      case '--app-id':
        if (!pair) throw new Error('--app-id 需要一个值');
        flags.appId = pair.value;
        i = pair.next;
        break;
      case '--app-secret':
        if (!pair) throw new Error('--app-secret 需要一个值');
        flags.appSecret = pair.value;
        i = pair.next;
        break;
      case '--domain': {
        if (!pair) throw new Error('--domain 需要 feishu 或 lark');
        const domain = asDomain(pair.value);
        if (!domain) throw new Error('--domain 只能是 feishu 或 lark');
        flags.domain = domain;
        i = pair.next;
        break;
      }
      case '--llm-base-url':
        if (!pair) throw new Error('--llm-base-url 需要一个值');
        flags.llmBaseUrl = pair.value;
        i = pair.next;
        break;
      case '--llm-model':
        if (!pair) throw new Error('--llm-model 需要一个值');
        flags.llmModel = pair.value;
        i = pair.next;
        break;
      case '--llm-key':
        if (!pair) throw new Error('--llm-key 需要一个值');
        flags.llmApiKey = pair.value;
        i = pair.next;
        break;
      case '--tracing': {
        if (!pair) throw new Error('--tracing 需要 none | langfuse | langsmith | both');
        const tracing = asTracing(pair.value);
        if (!tracing) throw new Error('--tracing 只能是 none | langfuse | langsmith | both');
        flags.tracing = tracing;
        i = pair.next;
        break;
      }
      case '--langfuse-public-key':
        if (!pair) throw new Error('--langfuse-public-key 需要一个值');
        flags.langfusePublicKey = pair.value;
        i = pair.next;
        break;
      case '--langfuse-secret-key':
        if (!pair) throw new Error('--langfuse-secret-key 需要一个值');
        flags.langfuseSecretKey = pair.value;
        i = pair.next;
        break;
      case '--langfuse-base-url':
        if (!pair) throw new Error('--langfuse-base-url 需要一个值');
        flags.langfuseBaseUrl = pair.value;
        i = pair.next;
        break;
      case '--langsmith-api-key':
        if (!pair) throw new Error('--langsmith-api-key 需要一个值');
        flags.langsmithApiKey = pair.value;
        i = pair.next;
        break;
      case '--langsmith-project':
        if (!pair) throw new Error('--langsmith-project 需要一个值');
        flags.langsmithProject = pair.value;
        i = pair.next;
        break;
      case '--langsmith-endpoint':
        if (!pair) throw new Error('--langsmith-endpoint 需要一个值');
        flags.langsmithEndpoint = pair.value;
        i = pair.next;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return flags;
}
