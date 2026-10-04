function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

export const config = {
  lark: {
    appId: req('LARK_APP_ID'),
    appSecret: req('LARK_APP_SECRET'),
    domain: process.env.LARK_DOMAIN?.trim() || undefined,
    botName: process.env.LARK_BOT_NAME?.trim() || 'Lark Interact Bot',
  },
  staleMessageThresholdMs: Number(process.env.STALE_MESSAGE_THRESHOLD_MS ?? 300_000),
} as const;
