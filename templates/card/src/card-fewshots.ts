/**
 * 卡片组件 few-shot 示例，用于增强 systemPrompt 的生成质量。
 *
 * 片段提炼自飞书卡片常见组件组合，并按本项目
 * checkCardDsl（@open-feishu-card/validator + schema）逐条验证通过。
 */
export const cardFewShots = `[卡片组件示例（few-shot，均已通过 schema 2.0 校验，可直接放进 body.elements，占位文字按需替换；示例⑤⑥为复制交互；示例⑦为折叠面板）]

① KPI 指标卡（数据看板；等宽列 = weight:1 + width:"weighted"；色底列必须带 padding 才有留白）：
{"tag":"column_set","flex_mode":"none","background_style":"default","horizontal_spacing":"8px","columns":[{"tag":"column","background_style":"blue-50","direction":"vertical","weight":1,"width":"weighted","padding":"12px 16px 12px 16px","elements":[{"tag":"markdown","content":"<font color='grey'>总利润</font>","text_size":"small"},{"tag":"markdown","content":"<font color='blue-600'>**￥24,850**</font>","text_size":"heading"},{"tag":"markdown","content":"<font color='grey'>同比昨日</font> <font color='green'>**▲ 12%**</font>","text_size":"small"}]},{"tag":"column","background_style":"green-50","direction":"vertical","weight":1,"width":"weighted","padding":"12px 16px 12px 16px","elements":[{"tag":"markdown","content":"<font color='grey'>净利润</font>","text_size":"small"},{"tag":"markdown","content":"<font color='green-600'>**￥8,210**</font>","text_size":"heading"},{"tag":"markdown","content":"<font color='grey'>同比昨日</font> <font color='red'>**▼ 3%**</font>","text_size":"small"}]}]}
简约变体（数字在上、标签在下、text_align:"center"）：
{"tag":"column_set","flex_mode":"none","horizontal_spacing":"8px","columns":[{"tag":"column","background_style":"green-50","direction":"vertical","weight":1,"width":"weighted","padding":"12px 16px 12px 16px","elements":[{"tag":"markdown","content":"<font color='green-600'>**￥24,850**</font>","text_size":"heading","text_align":"center"},{"tag":"markdown","content":"<font color='grey'>总利润</font>","text_size":"small","text_align":"center"}]}]}

② 特性/高亮块（emoji + 同色彩色加粗标题 + 小字说明；适合并列展示 2~3 个卖点）：
{"tag":"column_set","flex_mode":"none","horizontal_spacing":"8px","columns":[{"tag":"column","background_style":"blue-50","direction":"vertical","weight":1,"width":"weighted","padding":"12px 16px 12px 16px","elements":[{"tag":"markdown","content":"<font color='blue-600'>**🎙️ 一键唤醒**</font>"},{"tag":"markdown","content":"默认 F8 键，可自定义快捷键","text_size":"small"}]},{"tag":"column","background_style":"turquoise-50","direction":"vertical","weight":1,"width":"weighted","padding":"12px 16px 12px 16px","elements":[{"tag":"markdown","content":"<font color='turquoise-600'>**⚡ 极速转写**</font>"},{"tag":"markdown","content":"豆包云端模型，毫秒级响应","text_size":"small"}]}]}

③ 图标信息条（grey-50 底 + standard_icon 图标 + div 正文；常用 token：info_outlined / alarm_outlined / check_circle_outlined）：
{"tag":"column_set","flex_mode":"none","horizontal_spacing":"8px","columns":[{"tag":"column","background_style":"grey-50","direction":"vertical","weight":1,"width":"weighted","padding":"12px 12px 12px 12px","elements":[{"tag":"column_set","flex_mode":"none","horizontal_spacing":"8px","columns":[{"tag":"column","direction":"vertical","width":"auto","elements":[{"tag":"div","width":"fill","text":{"tag":"plain_text","content":""},"icon":{"tag":"standard_icon","token":"info_outlined","color":"grey"}}]},{"tag":"column","direction":"vertical","weight":1,"width":"weighted","elements":[{"tag":"div","width":"fill","text":{"tag":"plain_text","content":"这里是提示说明文字，可完整换行展示。"}}]}]}]}]}

④ 强调框（官方组件库原样式：白底 + 彩色边框 + 圆角，text_tag 徽标 + 正文；可选组件，仅当用户明确要求强调/总结块、或内容里确有关键结论、重要提醒需要突出时才用）：
{"tag":"interactive_container","background_style":"bg-white","border_color":"blue-400","direction":"vertical","disabled":true,"elements":[{"tag":"markdown","content":"<text_tag color='blue'>核心观点</text_tag>  这里放需要强调的正文：关键结论、重要提醒、注意事项、行动号召等。","text_align":"left","text_size":"normal"}],"has_border":true,"padding":"12px 16px 12px 16px","width":"fill","corner_radius":"8px"}
纯视觉不点击就保留 disabled:true，behaviors 可省略（disabled 纯视觉不校验 behaviors）；要真实点击跳转时去掉 disabled 并自带 behaviors:[{"type":"open_url","default_url":"真实链接"}]。column_set 色块没有边框线，要边框必须用 interactive_container；已有色块**改结构**（加边框）时才 replace 整个 /body/elements/<N>，仅改色/改字用叶子 path（…/content、…/background_style 等）。
无边框的轻量色块变体（视觉更素）：
{"tag":"column_set","flex_mode":"none","horizontal_spacing":"8px","columns":[{"tag":"column","background_style":"blue-50","direction":"vertical","weight":1,"width":"weighted","padding":"12px 16px 12px 16px","elements":[{"tag":"markdown","content":"<text_tag color='blue'>重点关注</text_tag>"},{"tag":"markdown","content":"任何需要突出的内容都可以放这里：关键结论、重要提醒、注意事项、行动号召等。"}]}]}

⑤ 复制按钮（用户很可能要把该值粘贴到别处时：电话/邮箱/地址/密钥/URL 等；左展示 + 右「复制」；lark copy scheme 只写在 pc/ios/android_url，default_url 用 https 兜底）：
{"tag":"column_set","flex_mode":"none","horizontal_spacing":"8px","columns":[{"tag":"column","direction":"vertical","weight":1,"width":"weighted","elements":[{"tag":"markdown","content":"\`support@example.com\`","text_size":"notation"}]},{"tag":"column","direction":"vertical","width":"auto","vertical_align":"center","elements":[{"tag":"button","text":{"tag":"plain_text","content":"复制"},"type":"default","size":"small","width":"default","behaviors":[{"type":"open_url","default_url":"https://example.com","pc_url":"lark://client/core/copy?value=support%40example.com","ios_url":"lark://client/core/copy?value=support%40example.com","android_url":"lark://client/core/copy?value=support%40example.com"}]}]}]}
同一行已有主 CTA 按钮时，复制按钮降级 type:"text"；多个独立字段（电话 + 邮箱 + 地址）各独占一行，不要混在一段 markdown 里只给一颗按钮

⑥ 点击复制（interactive_container：代码/命令/较长片段等，点整块复制；hover_tips 提示；behaviors 写法同⑤）：
{"tag":"interactive_container","background_style":"grey-50","direction":"vertical","padding":"8px 12px 8px 12px","width":"fill","corner_radius":"8px","hover_tips":{"tag":"plain_text","content":"点击复制"},"behaviors":[{"type":"open_url","default_url":"https://example.com","pc_url":"lark://client/core/copy?value=pnpm%20install%20%40scope%2Fpkg","ios_url":"lark://client/core/copy?value=pnpm%20install%20%40scope%2Fpkg","android_url":"lark://client/core/copy?value=pnpm%20install%20%40scope%2Fpkg"}],"elements":[{"tag":"markdown","content":"\`\`\`\\npmn install @scope/pkg\\n\`\`\`","text_size":"notation"}]}
纯展示、不需要复制时仍用 disabled:true 的强调框（示例④），不要误加 lark copy behaviors

⑦ 折叠面板（collapsible_panel：长内容默认折叠；边框/背景 API 与 interactive_container 不同，禁止 has_border/border_color/corner_radius/background_style）：
{"tag":"collapsible_panel","expanded":false,"background_color":"grey-50","padding":"8px 12px 8px 12px","border":{"color":"grey","corner_radius":"8px"},"header":{"title":{"tag":"plain_text","content":"🗓️ 下周工作规划"},"icon":{"tag":"standard_icon","token":"down-bold_outlined","color":"grey","size":"16px 16px"},"icon_position":"right","icon_expanded_angle":-180},"elements":[{"tag":"markdown","content":"1. 启动二期核心模块方案评审与开发排期\\n2. 沉淀性能优化技术文档并在组内组织技术分享\\n3. 持续跟进线上告警与核心链路稳定性监控"}]}
加边框写 border:{"color":"grey","corner_radius":"8px"}（不设 border 则无边框）；背景用 background_color；展开箭头放 header.icon + icon_position:"right" + icon_expanded_angle:-180。markdown 改折叠：replace /body/elements/<N> 为整块 collapsible_panel；仅加边框/icon 时用 add …/border、…/header/icon 等叶子 path。

markdown 加粗正反例（** 与全角标点相邻的规则，适用于所有 markdown content）：
- ✓ \`将「**人类反馈捕获 ➔ Skill 文件更新 ➔ PR 审查合并**」设计为标准化闭环\`
- ✓ \`将 **「人类反馈捕获 ➔ Skill 文件更新 ➔ PR 审查合并」** 设计为标准化闭环\`
- ✗ \`将**「人类反馈捕获 ➔ Skill 文件更新 ➔ PR 审查合并」**设计为标准化闭环\`（加粗失效，星号原样显示）
- 标点在加粗范围外侧时始终安全：\`**Warp**（AI 终端）\`、\`1. **事件触发**：用户提交\`

排版惯例（源自官方组件库，务必遵循）：
- 信息层级：主数字/标题用 text_size:"heading" 或 "normal" 且 **加粗**，说明用 "small"，脚注/签名用 "notation"
- 图片：没有可用的飞书 img_key 时不要写 img 组件，改用 standard_icon 或文本。用户原图或其它已上传图才用真实 \`img_key\`（\`img_v3_…\`）。通用写法：{"tag":"img","img_key":"…","alt":{"tag":"plain_text","content":"描述"},"scale_type":"fit_horizontal","corner_radius":"8px"}；默认 corner_radius:"8px"，用户要求直角时再省略
- 视频组件示例：{"tag":"video","file_key":"file_v3_…（get_message_detail 的 card_media）","cover":{"img_key":"img_v3_…（cover_img_key）"},"show_time":true,"enable_download":true}
- 音频可嵌在 markdown：{"tag":"markdown","content":"<audio file_key='file_v3_…' audio_id='任意uuid' show_time=true></audio>"}（file_key 来自 card_media；audio_id 任意唯一字符串即可）
- 分割线要克制：色块、分栏本身已是分区，优先用留白和背景色块分隔，确需时用少量 {"tag":"hr"}
- 以上片段是积木：按用户需求挑选需要的组件组合`;
