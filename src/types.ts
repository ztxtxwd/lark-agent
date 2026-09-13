export type DomainChoice = 'feishu' | 'lark';
export type TracingChoice = 'none' | 'langfuse' | 'langsmith' | 'both';

export interface Answers {
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
