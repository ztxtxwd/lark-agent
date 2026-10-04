import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLarkChannel } from '@larksuite/channel';
import { config } from './config.js';
import { handleCardAction, handleDeveloperMessage } from './handler.js';
import { registerWelcomeHandlers } from './welcome.js';

async function main() {
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
    safety: {
      staleMessageWindowMs: config.staleMessageThresholdMs,
      /**
       * channel 对 cardAction 的去重 key 是
       * `card:{messageId}:{openId}:{tag}|{name}|{option}|{value}`（不含飞书 event_id）。
       * 默认 TTL 12h，导致「同一人再点同一投票按钮」被当成重复投递直接丢掉。
       * 投票场景需要允许重复点同一选项；TTL 只挡真正的短时重投即可。
       */
      dedup: {
        ttl: 3_000,
      },
      chatQueue: {
        cardActions: 'separate',
      },
    },
  });

  channel.on('message', (msg) => {
    void handleDeveloperMessage(client, channel, msg).catch((err) => {
      console.error('[message]', err);
    });
  });

  channel.on('cardAction', (evt) => handleCardAction(client, channel, evt));

  registerWelcomeHandlers(channel);
  channel.on('error', (err) => console.error('[channel]', err));

  await channel.connect();
  console.log(`✓ ${config.lark.botName} 已连接。Ctrl-C 退出。`);

  let shuttingDown = false;
  const bye = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await channel.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
