# lark-agent

一条命令，搭一个能在飞书里文字对话的 Agent。

初始化时填入应用凭证、模型 Base URL、模型名称、Key，以及可选的 Langfuse / LangSmith。生成出来的工程只保留最基础的提示词和工具：用户发给机器人的消息，用文字回回去。

```bash
pnpm create lark-agent
# 或
npm create lark-agent
# 或
npx create-lark-agent
```

## 初始化会问什么

| 项 | 说明 |
|---|---|
| 项目名 | 工程目录、package.json 名称、默认机器人名都从这里来 |
| 飞书 App ID / App Secret | 开放平台应用凭证 |
| 开放平台 | 飞书或 Lark 国际版 |
| 模型 Base URL / 名称 / Key | OpenAI 兼容接口 |
| Langfuse / LangSmith | 可选，之后也能在 `.env` 里补 |

也可以把凭证写在命令行，少问几步：

```bash
pnpm create lark-agent my-bot \
  --app-id cli_xxx \
  --app-secret xxx \
  --llm-base-url https://api.openai.com/v1 \
  --llm-model gpt-4.1-mini \
  --llm-key sk-xxx \
  --tracing langfuse
```

`--yes` 会跳过可选问题（项目名默认 `lark-agent-bot`，观测默认不配），凭证缺了还是会问。

## 生成之后

```bash
cd my-bot
pnpm start
```

飞书应用请用 **长连接** 订阅 `im.message.receive_v1`，然后私聊机器人，或在群里 @ 它。群聊需要 @；单聊直接说即可。

生成工程里的说明见模板自带的 `README.md`：怎么改提示词、怎么加工具、怎么开观测。

## 这个仓库

本仓库是 `create-lark-agent` 本身。发布到 npm 之后才能用 `pnpm create lark-agent`。本地调试：

```bash
pnpm install
pnpm create ../my-bot
# 或先 pnpm build，再 node dist/cli.mjs ../my-bot
```

模板在 `template/`。create 会把它拷到目标目录，再写入 `.env`。想改生成结果，先改模板。

## 许可证

MIT
