function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

const bool = (name: string) => process.env[name]?.trim().toLowerCase() === 'true';

export const config = {
  llm: {
    baseUrl: process.env.LLM_BASE_URL?.trim() || 'https://api.openai.com/v1',
    apiKey: req('LLM_API_KEY'),
    modelId: process.env.LLM_MODEL?.trim() || 'gpt-4.1-mini',
  },
  lark: {
    appId: req('LARK_APP_ID'),
    appSecret: req('LARK_APP_SECRET'),
    domain: process.env.LARK_DOMAIN?.trim() || undefined,
    botName: process.env.LARK_BOT_NAME?.trim() || 'Lark Agent',
    /** 卡片水印链接；未配置则不追加/不按 URL 剥离水印 */
    botUrl: process.env.LARK_BOT_URL?.trim() || '',
  },
  historyLimit: Number(process.env.LARK_HISTORY_LIMIT ?? 30),
  staleMessageThresholdMs: Number(process.env.STALE_MESSAGE_THRESHOLD_MS ?? 300_000),
} as const;

export const langfuseConfig = {
  enabled:
    bool('LANGFUSE_TRACING') &&
    Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim()) &&
    Boolean(process.env.LANGFUSE_SECRET_KEY?.trim()),
  publicKey: process.env.LANGFUSE_PUBLIC_KEY?.trim() ?? '',
  secretKey: process.env.LANGFUSE_SECRET_KEY?.trim() ?? '',
  baseUrl: process.env.LANGFUSE_BASE_URL?.trim() || 'https://cloud.langfuse.com',
};

export const langsmithConfig = {
  enabled: bool('LANGSMITH_TRACING') && Boolean(process.env.LANGSMITH_API_KEY?.trim()),
  apiKey: process.env.LANGSMITH_API_KEY?.trim() ?? '',
  project: process.env.LANGSMITH_PROJECT?.trim() || config.lark.botName,
  endpoint: process.env.LANGSMITH_ENDPOINT?.trim() || 'https://api.smith.langchain.com',
};
