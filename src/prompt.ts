import * as p from '@clack/prompts';
import { DEFAULT_PROJECT_NAME, nameFromPath, toDirName, toPackageName } from './names.js';
import type { Answers, CliFlags, DomainChoice, TemplateChoice, TracingChoice } from './types.js';

export const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_LLM_MODEL = 'gpt-4.1-mini';
export const PLACEHOLDER_APP_ID = 'cli_xxx';
export const PLACEHOLDER_APP_SECRET = 'your_app_secret';
export const PLACEHOLDER_LLM_API_KEY = 'sk-REPLACE_ME';

function cancelIf<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('已取消');
    process.exit(0);
  }
  return value;
}

function needLangfuse(tracing: TracingChoice): boolean {
  return tracing === 'langfuse' || tracing === 'both';
}

function needLangsmith(tracing: TracingChoice): boolean {
  return tracing === 'langsmith' || tracing === 'both';
}

function env(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

/** stdin 非 TTY、CI、或显式 `--yes` 时进入非交互：绝不读 stdin。 */
export function isNonInteractive(flags: CliFlags): boolean {
  if (flags.yes) return true;
  if (process.env.CREATE_LARK_AGENT_NONINTERACTIVE === '1') return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return true;
  // 管道 / 关闭 stdin 时 isTTY 多为 undefined（不是 false）
  if (!process.stdin.isTTY) return true;
  return false;
}

function pick(
  ...candidates: Array<string | undefined>
): string | undefined {
  for (const c of candidates) {
    const v = c?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * 用 flags / 环境变量填答案；缺的再问。
 * 非交互（`--yes`、无 TTY、CI）下永不 prompt，缺省写占位值并警告。
 */
export async function collectAnswers(flags: CliFlags): Promise<Answers> {
  const nonInteractive = isNonInteractive(flags);
  if (nonInteractive && !flags.yes) {
    p.log.message('检测到非交互环境（无 TTY / CI），使用默认值与占位配置继续');
  }

  const template: TemplateChoice =
    flags.template ??
    (nonInteractive
      ? 'chat'
      : cancelIf(
          await p.select({
            message: '模板',
            options: [
              { value: 'chat', label: '对话：用户发文字，用文字回复（需 LLM）' },
              {
                value: 'card',
                label: '卡片生成：一句话生成或修改飞书卡片（需 LLM）',
              },
              {
                value: 'interact',
                label: '卡片交互：按钮回调 / 投票加人等（无需 LLM）',
              },
            ],
            initialValue: 'chat',
          }),
        ));

  const needsLlm = template !== 'interact';

  const givenPath = flags.directory?.trim();
  const projectName =
    pick(flags.name, givenPath ? nameFromPath(givenPath) : undefined) ||
    (nonInteractive
      ? DEFAULT_PROJECT_NAME
      : cancelIf(
          await p.text({
            message: '项目名',
            placeholder: DEFAULT_PROJECT_NAME,
            defaultValue: DEFAULT_PROJECT_NAME,
            validate: (v) => (v.trim() ? undefined : '请填写项目名'),
          }),
        ).trim() || DEFAULT_PROJECT_NAME);

  const directory = givenPath || toDirName(projectName);
  const packageName = toPackageName(projectName);

  const botName =
    pick(flags.botName) ||
    (nonInteractive
      ? projectName
      : cancelIf(
          await p.text({
            message: '机器人名称',
            defaultValue: projectName,
          }),
        ).trim() || projectName);

  const appIdFromEnv = env('LARK_APP_ID') ?? env('FEISHU_APP_ID');
  const appSecretFromEnv = env('LARK_APP_SECRET') ?? env('FEISHU_APP_SECRET');

  let appId = pick(flags.appId, appIdFromEnv);
  if (!appId) {
    if (nonInteractive) {
      appId = PLACEHOLDER_APP_ID;
      p.log.warn('未提供 App ID，已写入占位值；请改 .env 或传 --app-id / 环境变量 LARK_APP_ID');
    } else {
      appId = cancelIf(
        await p.text({
          message: '飞书应用 App ID',
          placeholder: 'cli_xxx',
          validate: (v) => (v.trim() ? undefined : '请填写 App ID'),
        }),
      ).trim();
    }
  }

  let appSecret = pick(flags.appSecret, appSecretFromEnv);
  if (!appSecret) {
    if (nonInteractive) {
      appSecret = PLACEHOLDER_APP_SECRET;
      p.log.warn(
        '未提供 App Secret，已写入占位值；请改 .env 或传 --app-secret / 环境变量 LARK_APP_SECRET',
      );
    } else {
      appSecret = cancelIf(
        await p.password({
          message: '飞书应用 App Secret',
          validate: (v) => (v.trim() ? undefined : '请填写 App Secret'),
        }),
      ).trim();
    }
  }

  const domainFromEnv = env('LARK_DOMAIN') ?? env('FEISHU_DOMAIN');
  const domainRaw = flags.domain ?? (domainFromEnv === 'lark' || domainFromEnv === 'feishu' ? domainFromEnv : undefined);
  const domain: DomainChoice =
    domainRaw ??
    (nonInteractive
      ? 'feishu'
      : cancelIf(
          await p.select({
            message: '开放平台',
            options: [
              { value: 'feishu', label: '飞书（open.feishu.cn）' },
              { value: 'lark', label: 'Lark（open.larksuite.com）' },
            ],
            initialValue: 'feishu',
          }),
        ));

  let llmBaseUrl = pick(flags.llmBaseUrl, env('LLM_BASE_URL')) ?? '';
  let llmModel = pick(flags.llmModel, env('LLM_MODEL')) ?? '';
  let llmApiKey = pick(flags.llmApiKey, env('LLM_API_KEY')) ?? '';

  if (needsLlm) {
    if (!llmBaseUrl) {
      if (nonInteractive) {
        llmBaseUrl = DEFAULT_LLM_BASE_URL;
      } else {
        llmBaseUrl = cancelIf(
          await p.text({
            message: '模型 Base URL（OpenAI 兼容）',
            placeholder: DEFAULT_LLM_BASE_URL,
            defaultValue: DEFAULT_LLM_BASE_URL,
            validate: (v) => (v.trim() ? undefined : '请填写 Base URL'),
          }),
        ).trim();
      }
    }

    if (!llmModel) {
      if (nonInteractive) {
        llmModel = DEFAULT_LLM_MODEL;
      } else {
        llmModel = cancelIf(
          await p.text({
            message: '模型名称',
            placeholder: DEFAULT_LLM_MODEL,
            validate: (v) => (v.trim() ? undefined : '请填写模型名称'),
          }),
        ).trim();
      }
    }

    if (!llmApiKey) {
      if (nonInteractive) {
        llmApiKey = PLACEHOLDER_LLM_API_KEY;
        p.log.warn(
          '未提供模型 API Key，已写入占位值；请改 .env 或传 --llm-key / 环境变量 LLM_API_KEY',
        );
      } else {
        llmApiKey = cancelIf(
          await p.password({
            message: '模型 API Key',
            validate: (v) => (v.trim() ? undefined : '请填写 API Key'),
          }),
        ).trim();
      }
    }
  }

  const tracing: TracingChoice =
    flags.tracing ??
    (nonInteractive || !needsLlm
      ? 'none'
      : cancelIf(
          await p.select({
            message: '观测平台（可选，之后也能在 .env 里补）',
            options: [
              { value: 'none', label: '暂不配置' },
              { value: 'langfuse', label: 'Langfuse' },
              { value: 'langsmith', label: 'LangSmith' },
              { value: 'both', label: 'Langfuse + LangSmith' },
            ],
            initialValue: 'none',
          }),
        ));

  let langfusePublicKey = pick(flags.langfusePublicKey, env('LANGFUSE_PUBLIC_KEY')) ?? '';
  let langfuseSecretKey = pick(flags.langfuseSecretKey, env('LANGFUSE_SECRET_KEY')) ?? '';
  let langfuseBaseUrl =
    pick(flags.langfuseBaseUrl, env('LANGFUSE_BASE_URL')) ?? 'https://cloud.langfuse.com';
  if (needLangfuse(tracing)) {
    if (!langfusePublicKey) {
      if (nonInteractive) {
        p.log.warn('已选 Langfuse 但未提供 Public Key；请稍后补全 .env');
      } else {
        langfusePublicKey = cancelIf(
          await p.text({
            message: 'Langfuse Public Key',
            placeholder: 'pk-lf-...',
          }),
        ).trim();
      }
    }
    if (!langfuseSecretKey) {
      if (nonInteractive) {
        p.log.warn('已选 Langfuse 但未提供 Secret Key；请稍后补全 .env');
      } else {
        langfuseSecretKey = cancelIf(
          await p.password({
            message: 'Langfuse Secret Key',
          }),
        ).trim();
      }
    }
    if (!flags.langfuseBaseUrl && !env('LANGFUSE_BASE_URL') && !nonInteractive) {
      langfuseBaseUrl =
        cancelIf(
          await p.text({
            message: 'Langfuse Base URL',
            defaultValue: langfuseBaseUrl,
          }),
        ).trim() || langfuseBaseUrl;
    }
  }

  let langsmithApiKey = pick(flags.langsmithApiKey, env('LANGSMITH_API_KEY')) ?? '';
  let langsmithProject = pick(flags.langsmithProject, env('LANGSMITH_PROJECT')) ?? projectName;
  let langsmithEndpoint =
    pick(flags.langsmithEndpoint, env('LANGSMITH_ENDPOINT')) ?? 'https://api.smith.langchain.com';
  if (needLangsmith(tracing)) {
    if (!langsmithApiKey) {
      if (nonInteractive) {
        p.log.warn('已选 LangSmith 但未提供 API Key；请稍后补全 .env');
      } else {
        langsmithApiKey = cancelIf(
          await p.password({
            message: 'LangSmith API Key',
          }),
        ).trim();
      }
    }
    if (!flags.langsmithProject && !env('LANGSMITH_PROJECT') && !nonInteractive) {
      langsmithProject =
        cancelIf(
          await p.text({
            message: 'LangSmith Project',
            defaultValue: langsmithProject,
          }),
        ).trim() || langsmithProject;
    }
    if (!flags.langsmithEndpoint && !env('LANGSMITH_ENDPOINT') && !nonInteractive) {
      langsmithEndpoint =
        cancelIf(
          await p.text({
            message: 'LangSmith Endpoint',
            defaultValue: langsmithEndpoint,
          }),
        ).trim() || langsmithEndpoint;
    }
  }

  const install =
    flags.install ??
    (nonInteractive
      ? true
      : cancelIf(
          await p.confirm({
            message: '现在安装依赖？',
            initialValue: true,
          }),
        ));

  return {
    template,
    directory,
    projectName,
    packageName,
    botName,
    appId,
    appSecret,
    domain,
    llmBaseUrl,
    llmModel,
    llmApiKey,
    tracing,
    langfusePublicKey,
    langfuseSecretKey,
    langfuseBaseUrl,
    langsmithApiKey,
    langsmithProject,
    langsmithEndpoint,
    install,
  };
}
