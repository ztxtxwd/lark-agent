# lark-agent

一个飞书**卡片投放 + 交互**机器人：

1. 开发者在**私聊**把准备好的互动卡片发给 bot（转发卡片，或粘贴 schema 2.0 JSON）
2. bot 调用「获取用户或机器人所在的群列表」API，回复**群聊选择表单**
3. 开发者选群并提交后，bot 把卡片发到该群
4. 群成员点击卡片时，bot 响应 `card.action.trigger`（例如把投票人写进选项下的 `person_list`）

不接大模型。交互走飞书卡片回调，由 `@larksuite/channel` 的 `cardAction` 处理。

## 启动

```bash
pnpm install   # 或 npm install
pnpm start
```

开发时用 `pnpm dev`。凭证在 `.env`（可从 `.env.example` 复制）。

## 飞书开放平台

1. 创建企业自建应用，开启**机器人**能力。
2. **事件**长连接，至少：
   - `im.message.receive_v1`
3. **回调**长连接，必须：
   - `card.action.trigger`
4. 权限至少：
   - 读取用户发给机器人的单聊消息
   - 以应用身份发消息 / 发送消息卡片
   - **获取与更新群组信息**（或「获取群组信息」）——用于 [获取用户或机器人所在的群列表](https://open.feishu.cn/document/server-docs/group/chat/list)
5. 先 `pnpm start` 建连，再在开放平台保存长连接订阅。
6. 把机器人拉进目标群，再私聊投放。

## 行为

| 触发 | 行为 |
|---|---|
| 私聊发互动卡片 / 卡片 JSON | 拉取/解析卡片 → 列出机器人所在群 → 回复群选择表单 |
| 表单提交「发送到群聊」 | 把整理后的卡片发到所选群，表单卡变为「已发送」 |
| 群成员点「选 A/B/…」等 | 把操作者写入对应 `vote_*` 的 `person_list`，toast + 整卡刷新（`update_multi`） |
| 群内其它卡片点击 | toast 确认，并回写当前卡内容，避免交互失败 |

投放前会自动：

- 设置 `config.update_multi = true`
- 给「选 A/B/…」类按钮补 `behaviors: [{ type: "callback", value: { action: "vote", option } }]`
- 在每个投票选项标题下补齐空的 `person_list`（`vote_a` …）

群列表用 **tenant_access_token**，即**机器人所在群**（不含单聊）。列表上限 100。

投票交互在 `card.action.trigger` 回调响应里直接回写整卡（`toast` + `card`）。不要先 `updateCard` 再只回 toast，否则飞书会在交互结束时盖回点击前的卡，人员只会闪一下。

`@larksuite/channel` 默认会按「同消息 + 同人 + 同按钮 value」去重且 TTL 很长；模板里已把 `safety.dedup.ttl` 调到 3 秒，否则第二次点同一选项回调到不了业务代码。

## 重启后卡片不失效

投票快照用 **zwsteg** 嵌进卡片里**已有 markdown 正文末尾**（零宽、不另占一行）。  
每次投票回写整卡时一并封印；进程重启后：飞书回读该消息 → 还原投票 → **重装按钮 callback / `vote_*` list** → 继续响应。

查找顺序：**内存缓存 → 飞书回读（优先 `raw_card_content` + zwsteg；raw 解不出才退 `user_card_content`）**。不落本地盘。

注意：`im.message.get` 回读的卡通常**不含**按钮 `value`/`behaviors`，且 `element_id` 会被重编号 / raw 投影可能丢掉。若直接把回读 JSON 当回调 `card` 回写，整卡会坏掉（表面只剩 `om_…`）。模板在恢复时会 `rearmCardAfterFetch` 修好再回写。

`user_card_content` 会丢掉与服务端默认值相同的样式（如 column padding），因此只作兜底，日常走 raw。

若飞书存储时剥离零宽字符，zwsteg 会失效，此时仍可从回读到的 `person_list`（按选项标题位置）继续。

## 改什么

| 想改 | 文件 |
|---|---|
| 收卡 / 选群 / 投放 / 回调总控 | `src/handler.ts` |
| 零宽状态封印 / 还原 | `src/card-state.ts` |
| 拉群列表 | `src/chats.ts` |
| 解析卡片、投放前整理 | `src/card-io.ts` |
| 群选择表单 UI | `src/group-picker.ts` |
| 选项下追加 person | `src/person-vote.ts` |

## 参考

- [获取用户或机器人所在的群列表](https://open.feishu.cn/document/server-docs/group/chat/list)
- [开发一个卡片交互机器人](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/quick-start/develop-a-card-interactive-bot)
- [卡片回传交互回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-callback-communication)
- [人员列表 person_list](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/content-components/user-list)
- [表单容器](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/containers/form-container)
