#!/usr/bin/env node
import * as p from '@clack/prompts';
import color from 'picocolors';
import { parseFlags } from './flags.js';
import { collectAnswers } from './prompt.js';
import { copyTemplate, installCommand, resolveDest, runInstall, tryGitInit, writeEnv } from './scaffold.js';

function printHelp(): void {
  console.log(`
${color.bold('create-lark-agent')} — 创建一个飞书对话、卡片或交互 Agent

${color.dim('用法')}
  pnpm create lark-agent [项目名]
  npm create lark-agent [项目名]
  npx create-lark-agent [项目名]

${color.dim('常用参数')}
  --template chat|card|interact
      chat     文字对话（需 LLM）
      card     用 LLM 生成/修改卡片（需 LLM）
      interact 卡片按钮交互 / 投票（无需 LLM；别名 interactive）
  --name --bot-name --app-id --app-secret --domain feishu|lark
  --llm-base-url --llm-model --llm-key
  --tracing none|langfuse|langsmith|both
  --yes / -y          完全非交互（缺省用默认值与占位配置）
  --install --no-install

${color.dim('Agent / CI')}
  无 TTY、CI=1 或 --yes 时自动非交互，绝不读 stdin。
  「卡片交互机器人」→ --template interact；「用 AI 生成卡片」→ --template card。
  凭证也可来自环境变量：LARK_APP_ID、LARK_APP_SECRET、LLM_*。

${color.dim('非交互示例')}
  # 卡片交互（只需飞书凭证）
  pnpm create lark-agent my-bot --template interact --app-id cli_xxx --app-secret xxx --yes
  # 卡片生成（另需 LLM，未传则写占位值）
  pnpm create lark-agent my-card --template card --app-id cli_xxx --app-secret xxx --yes --no-install
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return;
  }

  const flags = parseFlags(argv);

  p.intro(color.bgBlue(color.white(' lark-agent ')) + color.dim('  创建一个飞书 Agent'));

  const answers = await collectAnswers(flags);
  const dest = resolveDest(answers.directory);

  const spin = p.spinner();
  spin.start('正在写入工程');
  await copyTemplate(dest, answers);
  await writeEnv(dest, answers);
  await tryGitInit(dest);
  spin.stop('工程已创建');

  if (answers.install) {
    const { pm, args } = installCommand();
    spin.start(`安装依赖（${pm} ${args.join(' ')}）`);
    try {
      await runInstall(dest);
      spin.stop('依赖已安装');
    } catch (err) {
      spin.stop('依赖安装失败，可稍后手动安装');
      p.log.warn(err instanceof Error ? err.message : String(err));
    }
  }

  const { pm } = installCommand();
  p.note(
    [
      `cd ${answers.directory}`,
      answers.install ? `${pm} start` : `${pm} install && ${pm} start`,
      '',
      answers.template === 'interact'
        ? '飞书开放平台请使用「长连接」订阅消息事件与卡片回传交互回调，'
        : '飞书开放平台请使用「长连接」订阅消息事件，',
      '然后私聊机器人，或在群里 @ 它。',
    ].join('\n'),
    '下一步',
  );
  p.outro(color.green('创建完成。'));
  // 机器可读一行，方便 agent 解析（不依赖 TUI）
  console.log(`CREATED=${dest}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
