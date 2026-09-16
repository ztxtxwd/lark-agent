# lark-agent

一个飞书卡片 Agent：用户描述需求，用互动卡片回复；也可以接着改已发出的卡片。

系统提示词里是卡片 schema 2.0 和一套通用组件 few-shot（KPI 分栏、强调框、复制、折叠面板）。没有 Modern Minimal / Custom Visual 等需要预上传图片的主题包。适合当自己的飞书卡片机器人起点。

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
   - 发送消息卡片
   - 更新应用发送的消息卡片
   - 获取与发送单聊、群组消息（用来带上下文）
   - 获取群历史消息
   - 消息表情回复（处理中会点一个 OnIt）
   - 上传图片（用户消息里的图会带进模型）
   - Pin 消息（「记住这张卡」时用）
4. 发布应用，私聊机器人或把它拉进群。

群里需要 @ 才会回；单聊直接说话即可。

## 模型

`LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` 走 **OpenAI 兼容** Chat Completions。OpenAI、OpenRouter、DeepSeek、自建 vLLM 都可以。卡片 JSON 比较长，建议用上下文足够的模型。

## 回复逻辑

入口在 `src/index.ts`：长连接收到 `message` 后交给 `Orchestrator.handleMessage`。

**先过滤，再排队。** 忽略自己发的消息、空内容、过期事件。同一会话同时只跑一轮：新消息到了会 abort 上一轮。

**一轮内部：**

1. 给当前消息点一个 OnIt 表情。
2. 默认不预拉历史 / Pin 列表。若判定用户在改卡（话里有改/换成等、转发了卡片、或「回复」了某条消息），则解析目标卡并注入完整 schema 2.0 JSON、elements 索引与底稿路径。
3. Agent 主要用 `reply_card` 发新卡、`modify_card` 打 JSON Patch 改卡、`reply_post` 说人话。
4. 发出前用 `@open-feishu-card` 做 schema 校验；失败把错误回给模型重试。
5. 工具没发出去、但模型吐了整段卡片 JSON，会尝试当卡片发出去；否则回落纯文本。

进群 / 首次单聊的欢迎语不走模型。

## 改什么

| 想改 | 文件 |
|---|---|
| 人设、出卡规矩 | `src/llm.ts` 里的 `systemPrompt` |
| 组件示例 | `src/card-fewshots.ts` |
| 给 Agent 加工具 | `src/agent.ts` 的 `makeTools` |
| 何时算「在改卡」、怎么找目标卡 | `src/edit-intent.ts`、`src/orchestrator.ts` |
| 历史怎么拉、怎么格式化 | `src/history.ts` |
| 提示词怎么拼、何时注入改卡底稿 | `src/orchestrator.ts` |
| 观测 | `.env` 里的 Langfuse / LangSmith |

## 观测（可选）

在 `.env` 打开即可，不配就不打点。

```bash
LANGFUSE_TRACING=true
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```
