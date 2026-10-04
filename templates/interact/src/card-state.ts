import { decode, encode } from 'zwsteg';

/** 历史专用态节点 id；新逻辑改嵌进已有正文，不再新建空 markdown。 */
const STATE_ELEMENT_ID = 'zw_state';
/** 卡片里完全没有可用 markdown 时的兜底 cover。 */
const COVER = '\u2060';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isRecord(node)) return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

/** option → open_id[] */
export type VoteSnapshot = Record<string, string[]>;

type StatePayload = {
  v: 1;
  votes: VoteSnapshot;
};

function readPersons(list: Record<string, unknown>): string[] {
  if (!Array.isArray(list.persons)) return [];
  return list.persons
    .filter(isRecord)
    .map((p) => (typeof p.id === 'string' ? p.id : null))
    .filter((id): id is string => Boolean(id));
}

/** 从 person_list（vote_*）导出投票快照。 */
export function snapshotVotesFromCard(card: Record<string, unknown>): VoteSnapshot {
  const votes: VoteSnapshot = {};
  walk(card, (obj) => {
    if (obj.tag !== 'person_list') return;
    const id = typeof obj.element_id === 'string' ? obj.element_id : '';
    if (!id.startsWith('vote_')) return;
    votes[id.slice('vote_'.length)] = readPersons(obj);
  });
  return votes;
}

/** 把快照写回 vote_* person_list（缺少的 list 会在 body 末尾创建）。 */
export function applyVoteSnapshot(card: Record<string, unknown>, votes: VoteSnapshot): void {
  const lists = new Map<string, Record<string, unknown>>();
  walk(card, (obj) => {
    if (obj.tag !== 'person_list') return;
    const id = typeof obj.element_id === 'string' ? obj.element_id : '';
    if (!id.startsWith('vote_')) return;
    lists.set(id.slice('vote_'.length), obj);
  });

  const body = isRecord(card.body) ? card.body : null;
  for (const [option, openIds] of Object.entries(votes)) {
    let list = lists.get(option);
    if (!list) {
      if (!body || !Array.isArray(body.elements)) continue;
      list = {
        tag: 'person_list',
        element_id: `vote_${option}`,
        lines: 1,
        show_avatar: true,
        show_name: true,
        size: 'small',
        persons: [],
      };
      body.elements.push(list);
      lists.set(option, list);
    }
    list.persons = openIds.map((id) => ({ id }));
  }
}

function isZwOnly(content: string): boolean {
  return content.length > 0 && content.replace(/[\u2060\u200b\u200c\u200d\ufeff\s]/g, '').length === 0;
}

/** 去掉 zwsteg secret，只留可见 cover。 */
function stripSeal(content: string): string {
  try {
    const { segments } = decode(content);
    const visible = segments
      .filter((s) => !s.isSecret)
      .map((s) => s.text)
      .join('');
    return visible;
  } catch {
    return content.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '');
  }
}

function packPayload(votes: VoteSnapshot, cover: string): string {
  const payload: StatePayload = { v: 1, votes };
  const json = JSON.stringify(payload);
  const base = cover.length > 0 ? cover : COVER;
  return encode(base, [{ pos: [...base].length, text: json }]);
}

function unpackPayload(encoded: string): VoteSnapshot | null {
  try {
    const { segments } = decode(encoded);
    const secret = segments
      .filter((s) => s.isSecret)
      .map((s) => s.text)
      .join('');
    if (!secret) return null;
    const parsed: unknown = JSON.parse(secret);
    if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.votes)) return null;
    const votes: VoteSnapshot = {};
    for (const [k, v] of Object.entries(parsed.votes)) {
      if (!Array.isArray(v)) continue;
      votes[k] = v.filter((id): id is string => typeof id === 'string');
    }
    return votes;
  } catch {
    return null;
  }
}

function findSealedMarkdown(card: Record<string, unknown>): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  walk(card, (obj) => {
    if (found) return;
    if (obj.tag !== 'markdown' || typeof obj.content !== 'string') return;
    if (unpackPayload(obj.content)) found = obj;
  });
  return found;
}

/**
 * 清掉历史空 `zw_state` / 纯零宽 markdown，并把各 markdown 上的旧 seal 剥成可见正文。
 */
function purgeEmptyStateHosts(card: Record<string, unknown>): void {
  const body = isRecord(card.body) ? card.body : null;
  if (!body || !Array.isArray(body.elements)) return;

  body.elements = body.elements.filter((el) => {
    if (!isRecord(el) || el.tag !== 'markdown' || typeof el.content !== 'string') return true;
    const cleaned = stripSeal(el.content);
    el.content = cleaned;
    if (isZwOnly(cleaned) || cleaned.length === 0) {
      // 旧版专用空态节点 / 回读残留，整段丢掉以免占高
      return false;
    }
    if (el.element_id === STATE_ELEMENT_ID) {
      // 已迁到正文宿主，不再保留专用 id
      delete el.element_id;
    }
    return true;
  });
}

/** 选 body 里最后一个有可见正文的 markdown 作宿主（不新建空行）。 */
function pickHostMarkdown(card: Record<string, unknown>): Record<string, unknown> | null {
  const body = isRecord(card.body) ? card.body : null;
  if (!body || !Array.isArray(body.elements)) return null;
  let host: Record<string, unknown> | null = null;
  for (const el of body.elements) {
    if (!isRecord(el) || el.tag !== 'markdown' || typeof el.content !== 'string') continue;
    if (isZwOnly(el.content) || el.content.length === 0) continue;
    host = el;
  }
  return host;
}

/**
 * 把当前 person_list 投票结果用 zwsteg 嵌进已有 markdown 正文末尾。
 * 不再单独插一行空 markdown，避免卡片底部多出一块空白高度。
 */
export function sealCardState(card: Record<string, unknown>): void {
  purgeEmptyStateHosts(card);

  let host = pickHostMarkdown(card);
  if (!host) {
    const body = isRecord(card.body) ? card.body : null;
    if (!body || !Array.isArray(body.elements)) return;
    // 极端兜底：没有可用正文时才建节点，并用负 margin 压高度
    host = {
      tag: 'markdown',
      element_id: STATE_ELEMENT_ID,
      content: COVER,
      text_size: 'notation',
      margin: '-16px 0px 0px 0px',
    };
    body.elements.push(host);
  }

  const cover = typeof host.content === 'string' ? host.content : COVER;
  host.content = packPayload(snapshotVotesFromCard(card), cover);
}

/**
 * 从卡片零宽状态还原 person_list。
 * @returns 是否成功解码到状态
 */
export function hydrateCardState(card: Record<string, unknown>): boolean {
  const el = findSealedMarkdown(card);
  if (!el || typeof el.content !== 'string') return false;
  const votes = unpackPayload(el.content);
  if (!votes) return false;
  applyVoteSnapshot(card, votes);
  return true;
}
