import * as p from '@clack/prompts';
import { DEFAULT_PROJECT_NAME, nameFromPath, toDirName, toPackageName } from './names.js';
import type { Answers, CliFlags, DomainChoice, TemplateChoice, TracingChoice } from './types.js';

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

/** 用 flags 填默认值，缺的再问。`--yes` 只跳过可选问题，凭证仍会追问。 */
export async function collectAnswers(flags: CliFlags): Promise<Answers> {
  const template: TemplateChoice =
    flags.template ??
    (flags.yes
      ? 'chat'
      : cancelIf(
          await p.select({
            message: '模板',
            options: [
              { value: 'chat', label: '对话：用户发文字，用文字回复' },
              { value: 'card', label: '卡片：一句话生成或修改飞书互动卡片' },
            ],
            initialValue: 'chat',
          }),
        ));

  const givenPath = flags.directory?.trim();
  const projectName =
    flags.name?.trim() ||
    (givenPath ? nameFromPath(givenPath) : undefined) ||
    (flags.yes
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
    flags.botName?.trim() ||
    (flags.yes
      ? projectName
      : cancelIf(
          await p.text({
            message: '机器人名称',
            defaultValue: projectName,
          }),
        ).trim() || projectName);

  const appId =
    flags.appId?.trim() ||
    cancelIf(
      await p.text({
        message: '飞书应用 App ID',
        placeholder: 'cli_xxx',
        validate: (v) => (v.trim() ? undefined : '请填写 App ID'),
      }),
    ).trim();

  const appSecret =
    flags.appSecret?.trim() ||
    cancelIf(
      await p.password({
        message: '飞书应用 App Secret',
        validate: (v) => (v.trim() ? undefined : '请填写 App Secret'),
      }),
    ).trim();

  const domain: DomainChoice =
    flags.domain ??
    (flags.yes
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

  const llmBaseUrl =
    flags.llmBaseUrl?.trim() ||
    cancelIf(
      await p.text({
        message: '模型 Base URL（OpenAI 兼容）',
        placeholder: 'https://api.openai.com/v1',
        defaultValue: 'https://api.openai.com/v1',
        validate: (v) => (v.trim() ? undefined : '请填写 Base URL'),
      }),
    ).trim();

  const llmModel =
    flags.llmModel?.trim() ||
    cancelIf(
      await p.text({
        message: '模型名称',
        placeholder: 'gpt-4.1-mini',
        validate: (v) => (v.trim() ? undefined : '请填写模型名称'),
      }),
    ).trim();

  const llmApiKey =
    flags.llmApiKey?.trim() ||
    cancelIf(
      await p.password({
        message: '模型 API Key',
        validate: (v) => (v.trim() ? undefined : '请填写 API Key'),
      }),
    ).trim();

  const tracing: TracingChoice =
    flags.tracing ??
    (flags.yes
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

  let langfusePublicKey = flags.langfusePublicKey?.trim() ?? '';
  let langfuseSecretKey = flags.langfuseSecretKey?.trim() ?? '';
  let langfuseBaseUrl = flags.langfuseBaseUrl?.trim() ?? 'https://cloud.langfuse.com';
  if (needLangfuse(tracing)) {
    if (!langfusePublicKey) {
      langfusePublicKey = cancelIf(
        await p.text({
          message: 'Langfuse Public Key',
          placeholder: 'pk-lf-...',
        }),
      ).trim();
    }
    if (!langfuseSecretKey) {
      langfuseSecretKey = cancelIf(
        await p.password({
          message: 'Langfuse Secret Key',
        }),
      ).trim();
    }
    if (!flags.langfuseBaseUrl && !flags.yes) {
      langfuseBaseUrl =
        cancelIf(
          await p.text({
            message: 'Langfuse Base URL',
            defaultValue: langfuseBaseUrl,
          }),
        ).trim() || langfuseBaseUrl;
    }
  }

  let langsmithApiKey = flags.langsmithApiKey?.trim() ?? '';
  let langsmithProject = flags.langsmithProject?.trim() ?? projectName;
  let langsmithEndpoint = flags.langsmithEndpoint?.trim() ?? 'https://api.smith.langchain.com';
  if (needLangsmith(tracing)) {
    if (!langsmithApiKey) {
      langsmithApiKey = cancelIf(
        await p.password({
          message: 'LangSmith API Key',
        }),
      ).trim();
    }
    if (!flags.langsmithProject && !flags.yes) {
      langsmithProject =
        cancelIf(
          await p.text({
            message: 'LangSmith Project',
            defaultValue: langsmithProject,
          }),
        ).trim() || langsmithProject;
    }
    if (!flags.langsmithEndpoint && !flags.yes) {
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
    (flags.yes
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
