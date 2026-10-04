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

type Person = { id: string };

function readPersons(list: Record<string, unknown>): Person[] {
  if (!Array.isArray(list.persons)) return [];
  return list.persons
    .filter(isRecord)
    .map((p) => (typeof p.id === 'string' ? { id: p.id } : null))
    .filter((p): p is Person => Boolean(p));
}

/**
 * 在卡片 JSON 上应用投票：把 openId 写进 `vote_<option>` 的 person_list，
 * 并从其它 vote_* 列表移除（每人一票，可改投）。
 * 返回是否发生变更。
 */
export function applyPersonVote(
  card: Record<string, unknown>,
  openId: string,
  option: string,
): { changed: boolean; label: string } {
  const targetId = `vote_${option}`;
  let target: Record<string, unknown> | undefined;
  const allLists: Record<string, unknown>[] = [];

  walk(card, (obj) => {
    if (obj.tag !== 'person_list') return;
    allLists.push(obj);
    if (obj.element_id === targetId) target = obj;
  });

  if (!target) {
    // 找不到专用 list 时：创建并挂到 body.elements 末尾（兜底）
    const body = isRecord(card.body) ? card.body : null;
    if (!body || !Array.isArray(body.elements)) {
      return { changed: false, label: option.toUpperCase() };
    }
    target = {
      tag: 'person_list',
      element_id: targetId,
      lines: 1,
      show_avatar: true,
      show_name: true,
      size: 'small',
      persons: [],
    };
    body.elements.push(target);
    allLists.push(target);
  }

  let changed = false;
  for (const list of allLists) {
    const id = typeof list.element_id === 'string' ? list.element_id : '';
    if (!id.startsWith('vote_')) continue;
    const persons = readPersons(list);
    if (id === targetId) {
      if (!persons.some((p) => p.id === openId)) {
        list.persons = [...persons, { id: openId }];
        changed = true;
      }
    } else if (persons.some((p) => p.id === openId)) {
      list.persons = persons.filter((p) => p.id !== openId);
      changed = true;
    }
  }

  return { changed, label: option.toUpperCase() };
}

export function parseVoteAction(value: unknown): string | null {
  const obj = coerceActionValue(value);
  if (!obj) return null;
  if (obj.action !== 'vote') return null;
  if (typeof obj.option !== 'string' || !obj.option) return null;
  return obj.option.toLowerCase();
}

export function parseDispatchAction(value: unknown): boolean {
  const obj = coerceActionValue(value);
  return Boolean(obj && obj.action === 'dispatch_card');
}

/** 飞书回传的 value 可能是 object，也可能是 JSON 字符串。 */
function coerceActionValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}
