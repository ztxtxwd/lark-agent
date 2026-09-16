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

## 上下文怎么构建

每一轮发给模型的不是「整段聊天 JSON」，而是两块文本：

1. **系统提示词**（`src/llm.ts` 的 `systemPrompt`）：人设、必须用 `reply_post` 回消息、不要编造。
2. **用户提示词**（`src/orchestrator.ts` 现场拼）：最近聊天记录 + 当前这条消息。

历史来自飞书 OpenAPI `im.message.list`（`src/history.ts`），不是 SDK 自己缓存的：

- 按当前会话 `chatId` 拉，时间上只取 **当前消息之前** 的（`end_time` = 当前消息 `createTime`）。
- 条数上限 `min(50, LARK_HISTORY_LIMIT)`，默认 30。
- 丢掉已删除的、以及当前这条（避免和下面的 `[用户消息]` 重复）。
- 接口按时间倒序返回，拉回来再按 `create_time` 排成正序。
- 发送者 `sender_type === 'app'` 记成机器人，其余记成用户。
- `text` / `post` 抽出正文，`@_user_1` 这类 mention key 还原成 `@名字`；图片、文件、语音、视频、表情、卡片等非文本只留占位，例如 `[图片]`。

拼好后长这样：

```text
[最近聊天记录]
用户: 昨天那份方案发了吗
机器人: 已发到群文件里
用户: 再补一页风险

[当前消息是对消息 om_xxx 的回复]

[用户消息]
补一下竞品对比
```

`[最近聊天记录]` 拉失败就省略，本轮仍用当前消息继续。`[当前消息是对消息 … 的回复]` 只在用户点了「回复某条」时出现。当前消息本身：有文字用文字；只有图片写成 `[图片]`；空内容直接丢掉，不进模型。

**不会进模型的：** 机器人自己发的回声、超过 `STALE_MESSAGE_THRESHOLD_MS`（默认 5 分钟）的过期事件、群里没 @ 机器人的消息（channel 策略 `requireMention: true`；单聊不需要 @）。

## 回复逻辑

入口在 `src/index.ts`：长连接收到 `message` 后交给 `Orchestrator.handleMessage`。

**先过滤，再排队。** 忽略自己发的消息、空内容、过期事件。同一会话同时只跑一轮：新消息到了会 `abort` 上一轮，上一轮不再发飞书消息。同一会话的轮次串行执行，避免历史还没拉完就叠两轮。

**一轮内部：**

1. 给当前消息点一个 OnIt 表情，表示处理中；结束或被中止时摘掉。
2. 按上一节拼出 `userPrompt`，连同 `systemPrompt` 交给 `runAgentTurn`（`src/agent.ts`）。
3. Agent 只有一个工具 `reply_post`。模型应调用它，`content` 写 Markdown；工具里调用 `channel.send({ markdown })` 发出去，然后 `terminate: true` 结束本轮。
4. 回落：工具没发出去、但模型吐了纯文本，就把这段当普通文本发出去；两者都没有，回一句「刚刚处理消息时出了点问题」。被新消息中止的轮次不发任何回复。
5. 处理抛错且没被 abort 时，同样回那句抱歉。

进群（`botAdded`）或用户第一次单聊机器人（`p2p_chat_create`）时，`src/welcome.ts` 会直接发欢迎语，不走模型和历史。

同会话里如果用户连着发，上一轮没跑完会被丢掉，只处理最新一条。

## 改什么

| 想改 | 文件 |
|---|---|
| 人设、回复规矩 | `src/llm.ts` 里的 `systemPrompt` |
| 给 Agent 加工具 | `src/agent.ts` 的 `makeTools` |
| 历史怎么拉、怎么格式化 | `src/history.ts` |
| 提示词怎么拼、何时回、何时丢掉上一轮 | `src/orchestrator.ts` |
| 观测 | `.env` 里的 Langfuse / LangSmith |

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
