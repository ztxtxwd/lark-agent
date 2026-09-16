import {
  createModels,
  createProvider,
  type Api,
  type Model,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { config } from './config.js';

export const systemPrompt = `你是 ${config.lark.botName}，一个飞书对话助手。

通过工具回复用户。用户能看到的只有你发给他的飞书消息。

工具：
- reply_post：发送文字回复。content 写 Markdown 正文。

规则：
- 跟随用户语言，简洁自然。
- 只根据用户消息和对话上下文作答，不编造不确定的事实。
- 必须调用 reply_post，用户才能看到回复。`;

const openaiModel: Model<'openai-completions'> = {
  id: config.llm.modelId,
  name: config.llm.modelId,
  api: 'openai-completions',
  provider: 'openai-compat',
  baseUrl: config.llm.baseUrl,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
};

export const models = createModels();

models.setProvider(
  createProvider({
    id: 'openai-compat',
    name: 'OpenAI Compatible',
    baseUrl: config.llm.baseUrl,
    auth: {
      apiKey: {
        name: 'LLM',
        resolve: async () => ({ auth: { apiKey: config.llm.apiKey } }),
      },
    },
    models: [openaiModel],
    api: openAICompletionsApi(),
  }),
);

export function resolveModel(): Model<Api> {
  const m = models.getModel('openai-compat', config.llm.modelId);
  if (!m) throw new Error(`未注册模型：openai-compat/${config.llm.modelId}`);
  return m;
}
