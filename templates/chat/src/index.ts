import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '@larksuite/channel';
import { config, langfuseConfig, langsmithConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { initTracing, shutdownTracing } from './tracing.js';
import { registerWelcomeHandlers } from './welcome.js';

async function main() {
  initTracing();

  const client = new lark.Client({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    domain: config.lark.domain,
  });

  const channel = createLarkChannel({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
    domain: config.lark.domain,
    respectProxyEnv: true,
    resolveSenderNames: true,
    policy: {
      requireMention: true,
      dmMode: 'open',
      botLoopGuard: {
        enabled: true,
        windowMs: 60_000,
        maxBotMentions: 8,
        scope: 'chat',
        onTrip: 'drop',
      },
    },
  });

  const orchestrator = new Orchestrator(client, channel);
  channel.on('message', (msg) => {
    void orchestrator.handleMessage(msg);
  });
  registerWelcomeHandlers(channel);
  channel.on('error', (err) => console.error('[channel]', err));

  await channel.connect();

  const traces = [
    langfuseConfig.enabled ? 'langfuse' : '',
    langsmithConfig.enabled ? 'langsmith' : '',
  ].filter(Boolean);
  console.log(
    `✓ ${config.lark.botName} 已连接${traces.length ? `（${traces.join(' + ')}）` : ''}。Ctrl-C 退出。`,
  );

  let shuttingDown = false;
  const bye = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await channel.disconnect().catch(() => {});
    await shutdownTracing();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
