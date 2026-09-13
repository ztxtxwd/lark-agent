#!/usr/bin/env node
import * as p from '@clack/prompts';
import color from 'picocolors';
import { parseFlags } from './flags.js';
import { collectAnswers } from './prompt.js';
import { copyTemplate, installCommand, resolveDest, runInstall, tryGitInit, writeEnv } from './scaffold.js';

function printHelp(): void {
  console.log(`
${color.bold('create-lark-agent')} — 创建一个能文字回复的飞书对话 Agent

${color.dim('用法')}
  pnpm create lark-agent [项目名]
  npm create lark-agent [项目名]
  npx create-lark-agent [项目名]

${color.dim('常用参数')}
  --name --bot-name --app-id --app-secret --domain feishu|lark
  --llm-base-url --llm-model --llm-key
  --tracing none|langfuse|langsmith|both
  --yes --install --no-install
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return;
  }

  const flags = parseFlags(argv);

  p.intro(color.bgBlue(color.white(' lark-agent ')) + color.dim('  创建一个飞书对话 Agent'));

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
      '飞书开放平台请使用「长连接」订阅消息事件，',
      '然后私聊机器人，或在群里 @ 它。',
    ].join('\n'),
    '下一步',
  );
  p.outro(color.green('创建完成。'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
