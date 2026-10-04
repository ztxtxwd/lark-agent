export type ChatOption = {
  chatId: string;
  name: string;
};

/** 开发者私聊提交、待投放到群的卡片草稿。 */
export type PendingDispatch = {
  card: Record<string, unknown>;
  sourceMessageId: string;
  operatorOpenId: string;
  chats: ChatOption[];
};

/** 已投放到群里的互动卡，用于响应 card.action.trigger。 */
export type DispatchedCard = {
  card: Record<string, unknown>;
  chatId: string;
};
