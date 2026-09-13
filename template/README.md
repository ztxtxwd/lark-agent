# lark-agent

一个最小可用的飞书对话 Agent：用户发来文字，用文字回复。

系统提示词里只有「你是谁、用 `reply_post` 回消息」；工具也只有这一个。适合当自己的飞书 Agent 起点，而不是完整产品。

## 启动

```bash
pnpm install   # 或 npm install
pnpm start
```

开发时用 `pnpm dev`，改代码会自动重启。

凭证在 `.env`。没有的话从 `.env.example` 复制一份再填。

## 飞书开放平台

1. 创建一个企业自建应用，拿到 App ID / App Secret。
2. 事件订阅选 **长连接**，订阅 `im.message.receive_v1`。
3. 权限至少打开：
   - 读取用户发给机器人的单聊消息
   - 读取用户在群组中 @ 机器人的消息
   - 以应用身份发消息
   - 获取群历史消息（用来带上下文）
   - 消息表情回复（处理中会点一个 OnIt）
4. 发布应用，私聊机器人或把它拉进群。

群里需要 @ 才会回；单聊直接说话即可。

## 模型

`LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` 走 **OpenAI 兼容** Chat Completions。OpenAI、OpenRouter、DeepSeek、自建 vLLM 都可以。

## 改什么

| 想改 | 文件 |
|---|---|
| 人设、回复规矩 | `src/llm.ts` 里的 `systemPrompt` |
| 给 Agent 加工具 | `src/agent.ts` 的 `makeTools` |
| 历史怎么拼进上下文 | `src/history.ts` |
| 观测 | `.env` 里的 Langfuse / LangSmith |

同会话里如果用户连着发，上一轮没跑完会被丢掉，只处理最新一条。

## 观测（可选）

在 `.env` 打开即可，不配就不打点。

```bash
LANGFUSE_TRACING=true
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com

LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_...
LANGSMITH_PROJECT=lark-agent
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
```
