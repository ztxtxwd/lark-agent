# lark-agent

一条命令，搭一个能在飞书里对话的 Agent。初始化时选模板：只回文字、一句话生成飞书卡片，或处理卡片按钮交互（如投票加人）。

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
| 模板 | `chat` 文字对话（需 LLM）；`card` 用 LLM 生成/修改卡片；`interact` 卡片按钮交互/投票（无需 LLM）。口语「卡片交互」选 `interact`，不要选 `card` |
| 项目名 | 工程目录、package.json 名称、默认机器人名都从这里来 |
| 飞书 App ID / App Secret | 开放平台应用凭证 |
| 开放平台 | 飞书或 Lark 国际版 |
| 模型 Base URL / 名称 / Key | OpenAI 兼容接口（`interact` 模板不需要） |
| Langfuse / LangSmith | 可选；`interact` 不配；之后也能在 `.env` 里补 |

也可以把凭证写在命令行，少问几步：

```bash
pnpm create lark-agent my-bot \
  --template interact \
  --app-id cli_xxx \
  --app-secret xxx
```

### Agent / 非交互

无 TTY、`CI=1` 或 `--yes` / `-y` 时**完全非交互**（不读 stdin，管道输入无效也没关系）：

| 缺省项 | 默认值 |
|---|---|
| 模板 | `chat` |
| 项目名 | `lark-agent-bot` |
| 开放平台 | `feishu` |
| 观测 | `none` |
| 安装依赖 | 是（可用 `--no-install` 关掉） |
| LLM Base URL / Model | `https://api.openai.com/v1` / `gpt-4.1-mini`（`interact` 不需要） |
| App ID / Secret / LLM Key | 占位值写入 `.env`，并打警告 |

凭证也可来自环境变量：`LARK_APP_ID`、`LARK_APP_SECRET`、`LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`。

```bash
# 卡片交互机器人：只需飞书凭证（无需 --llm-*）
pnpm create lark-agent my-bot \
  --template interact \
  --app-id cli_xxx \
  --app-secret xxx \
  --yes

# 用 AI 生成卡片：未传 LLM 时会写占位值到 .env
pnpm create lark-agent my-card \
  --template card \
  --app-id cli_xxx \
  --app-secret xxx \
  --yes --no-install
```

成功时 stdout 末尾会有一行 `CREATED=<绝对路径>`，方便解析。

## 生成之后

```bash
cd my-bot
pnpm start
```

飞书应用请用 **长连接** 订阅事件。`chat` / `card` 至少订阅 `im.message.receive_v1`；`interact` 还要在**回调**里订阅 `card.action.trigger`，并开通「获取群组信息」类权限以便列出机器人所在群。然后私聊机器人，或在群里 @ 它。群聊需要 @；单聊直接说即可。

生成工程里的说明见模板自带的 `README.md`：怎么改提示词、怎么加工具、怎么开观测、怎么改投票卡。

## 这个仓库

本仓库是 `create-lark-agent` 本身。发布到 npm 之后才能用 `pnpm create lark-agent`。本地调试不要用 `pnpm create …`（那会去下载 npm 上的 `create-*` 包），用仓库里的脚本：

```bash
pnpm install
pnpm run create -- ../my-interact-bot --template interact
# 或先 pnpm build，再 node dist/cli.mjs ../my-interact-bot --template interact
```

模板在 `templates/chat`、`templates/card`、`templates/interact`。create 会按所选模板拷到目标目录，再写入 `.env`。想改生成结果，先改对应模板。本地调试模板用 `pnpm run dev:<template>`（如 `pnpm run dev:interact`），凭证放在 `templates/<template>/.env`。

## 交流群

飞书交流群：[点此加入](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=78cg4594-5feb-4074-82e5-64f7ed5e078e)

## 许可证

MIT
