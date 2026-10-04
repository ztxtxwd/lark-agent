export type DomainChoice = 'feishu' | 'lark';
export type TracingChoice = 'none' | 'langfuse' | 'langsmith' | 'both';
export type TemplateChoice = 'chat' | 'card' | 'interact';

export interface Answers {
  /** 对话只回文字；卡片用 LLM 出卡；交互处理卡片按钮回调（如投票加人）。 */
  template: TemplateChoice;
  /** 给人看的项目名，也用作默认机器人名。 */
  projectName: string;
  /** package.json 的 name，已做成合法 npm 名。 */
  packageName: string;
  directory: string;
  botName: string;
  appId: string;
  appSecret: string;
  domain: DomainChoice;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  tracing: TracingChoice;
  langfusePublicKey: string;
  langfuseSecretKey: string;
  langfuseBaseUrl: string;
  langsmithApiKey: string;
  langsmithProject: string;
  langsmithEndpoint: string;
  install: boolean;
}

export interface CliFlags {
  directory?: string;
  template?: TemplateChoice;
  name?: string;
  botName?: string;
  appId?: string;
  appSecret?: string;
  domain?: DomainChoice;
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
  tracing?: TracingChoice;
  langfusePublicKey?: string;
  langfuseSecretKey?: string;
  langfuseBaseUrl?: string;
  langsmithApiKey?: string;
  langsmithProject?: string;
  langsmithEndpoint?: string;
  install?: boolean;
  yes?: boolean;
}
