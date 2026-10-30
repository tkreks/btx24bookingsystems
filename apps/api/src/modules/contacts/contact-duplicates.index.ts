import { DUPLICATE_CHANNELS, messageChannel, normalizeClientPhone, type ContactDuplicatesDto, type DuplicateContactDto, type DuplicateGroupDto, type DuplicateReason } from '@btx24/shared';

/**
 * Поиск дублей контактов (ADR 0022) — чистые функции над копией CRM: нормализация, группы
 * (union-find по телефону/почте, отдельно — по полному имени), фильтр и страницы.
 */

export type DuplicatesBy = 'all' | 'phone' | 'email' | 'name' | 'messenger';

/** Контакт копии CRM — только поля, нужные для поиска дублей. */
export interface IndexedContact extends DuplicateContactDto {
  phoneKeys: string[];
  emailKeys: string[];
  nameKey: string | null;
  /** ID в мессенджерах: `пространство:значение` (см. MESSENGER_SPACES). */
  messengerKeys: string[];
}

/**
 * Пространства ID мессенджеров: совпадение внутри одного пространства — дубль, между разными — нет
 * (номер WhatsApp и LID, ID и логин Telegram — разные пространства).
 */
export const MESSENGER_SPACES = {
  telegram: 'Telegram',
  'telegram-login': 'Telegram',
  whatsapp: 'WhatsApp',
  'whatsapp-lid': 'WhatsApp LID',
  max: 'MAX',
  'max-login': 'MAX',
} as const;
export type MessengerSpace = keyof typeof MESSENGER_SPACES;

/**
 * Поля контакта с ID мессенджеров по ролям сопоставления (system-fields): telegram, whatsapp (наше
 * множественное поле `<номер>@c.us` / `<ID>@lid`), max, whatsappLid, telegramLogin, maxLogin → коды UF.
 */
export type MessengerFieldCodes = Partial<Record<'telegram' | 'whatsapp' | 'max' | 'whatsappLid' | 'telegramLogin' | 'maxLogin', string[]>>;

const login = (v: string) => {
  const s = v.trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z][a-z0-9_.]{2,63}$/.test(s) ? s : null;
};
const digitsId = (v: string) => {
  const s = v.trim().replace(/@lid$/i, '');
  return /^\d{3,20}$/.test(s) && !/^0+$/.test(s) ? s : null;
};

/** Значения UF-поля (строка, число или массив) → ключи `пространство:значение`. */
export function messengerKeys(row: Record<string, unknown>, fields: MessengerFieldCodes): string[] {
  const out = new Set<string>();
  const values = (codes?: string[]) => (codes ?? []).flatMap((code) => (Array.isArray(row[code]) ? (row[code] as unknown[]) : [row[code]]).map(str).filter((x) => x.trim()));
  const add = (space: MessengerSpace, v: string | null) => v && out.add(`${space}:${v}`);
  for (const v of values(fields.telegram)) add('telegram', digitsId(v.replace(/^@/, '')));
  for (const v of values(fields.telegramLogin)) add('telegram-login', login(v));
  for (const v of values(fields.whatsapp)) {
    const m = /^(\d{5,20})@(c\.us|lid)$/i.exec(v.trim());
    if (m) add(m[2]!.toLowerCase() === 'lid' ? 'whatsapp-lid' : 'whatsapp', m[1]!);
  }
  for (const v of values(fields.whatsappLid)) add('whatsapp-lid', digitsId(v));
  for (const v of values(fields.max)) {
    const s = v.trim();
    add('max', s && s.length <= 64 && !/^0+$/.test(s) && !/\s/.test(s) ? s : null);
  }
  for (const v of values(fields.maxLogin)) add('max-login', login(v));
  return [...out];
}

/** «telegram-login:ivan» → «Telegram @ivan»; «whatsapp:7912…» → «WhatsApp +7912…». */
export function messengerKeyLabel(key: string): string {
  const i = key.indexOf(':');
  const space = key.slice(0, i) as MessengerSpace;
  const v = key.slice(i + 1);
  const label = MESSENGER_SPACES[space] ?? space;
  return `${label} ${space.endsWith('-login') ? `@${v}` : space === 'whatsapp' ? `+${v}` : v}`;
}

/**
 * Значение, общее для слишком многих контактов (служебный номер, «no@mail.ru»), не связывает их:
 * иначе цепочкой склеиваются сотни клиентов. На портале 2026-10-30: 127 номеров — у двух контактов,
 * единицы — у 3–4, дальше служебные (у 15–47 контактов) — порог 5.
 */
export const MAX_SHARED_KEY = 5;

export const normalizeEmail = (v: unknown): string | null => {
  const s = String(v ?? '').trim().toLowerCase();
  return s.includes('@') ? s : null;
};

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .split(' ')
    .filter(Boolean);

/** Полное имя: слова NAME+LAST_NAME(+SECOND_NAME), строчными, ё→е, по алфавиту; меньше двух слов — не ключ. */
export function normalizeName(name: unknown, lastName: unknown, secondName?: unknown): string | null {
  const w = words([name, lastName, secondName].map((x) => (typeof x === 'string' ? x : '')).join(' ')).sort();
  return w.length >= 2 ? w.join(' ') : null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const iso = (v: unknown): string | null => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const multi = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => (x && typeof x === 'object' ? str((x as { VALUE?: unknown }).VALUE) : str(x)).trim())
    .filter(Boolean);

const CHANNELS = new Set<string>(DUPLICATE_CHANNELS);

/**
 * Каналы клиента из поля IM: открытая линия — `{VALUE_TYPE:'IMOL', VALUE:'imol|<коннектор>|…'}`
 * (wz_whatsapp_…, btx24_telegram, fbinstagramdirect…), остальные — по VALUE_TYPE (TELEGRAM, VIBER…).
 * Код — `messageChannel`; неизвестные каналы (Skype, ссылки) не показываем.
 */
export function imChannels(v: unknown): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    if (!x || typeof x !== 'object') continue;
    const type = str((x as { VALUE_TYPE?: unknown }).VALUE_TYPE).toUpperCase();
    const value = str((x as { VALUE?: unknown }).VALUE);
    const code = type === 'IMOL' ? (value.split('|')[1] ?? '') : type;
    const channel = code ? messageChannel(code.toLowerCase()) : '';
    if (CHANNELS.has(channel) && !out.includes(channel)) out.push(channel);
  }
  return out;
}

/** Строка копии CRM (поля row) → контакт индекса. `photo` — готовый URL аватарки (см. сервис). */
export function indexContact(id: number, row: Record<string, unknown>, photo: string | null = null, fields: MessengerFieldCodes = {}): IndexedContact {
  const phones = [...new Set(multi(row.PHONE))];
  const emails = [...new Set(multi(row.EMAIL))];
  const name = [str(row.NAME), str(row.SECOND_NAME), str(row.LAST_NAME)].map((s) => s.trim()).filter(Boolean).join(' ');
  const assigned = Number(row.ASSIGNED_BY_ID);
  return {
    id,
    name: name || `Контакт #${id}`,
    phones,
    emails,
    createdAt: iso(row.DATE_CREATE),
    modifiedAt: iso(row.DATE_MODIFY),
    assignedById: Number.isSafeInteger(assigned) && assigned > 0 ? assigned : null,
    photo,
    messengers: imChannels(row.IM),
    phoneKeys: [...new Set(phones.map(normalizeClientPhone).filter((x): x is string => !!x))],
    emailKeys: [...new Set(emails.map(normalizeEmail).filter((x): x is string => !!x))],
    nameKey: normalizeName(row.NAME, row.LAST_NAME, row.SECOND_NAME),
    messengerKeys: messengerKeys(row, fields),
  };
}

interface Group {
  key: string;
  members: IndexedContact[];
  reasons: { kind: DuplicateReason; value: string }[];
}

class UnionFind {
  private readonly parent = new Map<number, number>();
  find(x: number): number {
    let r = x;
    while (this.parent.has(r) && this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
}

/** ключ → контакты с ним (только ключи, общие для 2..MAX_SHARED_KEY контактов). */
function shared(contacts: IndexedContact[], keysOf: (c: IndexedContact) => string[]): Map<string, IndexedContact[]> {
  const m = new Map<string, IndexedContact[]>();
  for (const c of contacts) for (const k of keysOf(c)) m.set(k, [...(m.get(k) ?? []), c]);
  for (const [k, list] of m) if (list.length < 2 || list.length > MAX_SHARED_KEY) m.delete(k);
  return m;
}

type LinkKind = 'phone' | 'email' | 'messenger';
const KEYS_OF: Record<LinkKind, (c: IndexedContact) => string[]> = { phone: (c) => c.phoneKeys, email: (c) => c.emailKeys, messenger: (c) => c.messengerKeys };

/** Телефон/почта/мессенджер: связанные контакты — одна группа (A~B по телефону, B~C по почте → A, B, C). */
function linkedGroups(contacts: IndexedContact[], kinds: LinkKind[]): Group[] {
  const uf = new UnionFind();
  const keys: { kind: LinkKind; value: string; members: IndexedContact[] }[] = [];
  for (const kind of kinds)
    for (const [value, members] of shared(contacts, KEYS_OF[kind])) {
      keys.push({ kind, value: kind === 'messenger' ? messengerKeyLabel(value) : value, members });
      for (const c of members.slice(1)) uf.union(members[0]!.id, c.id);
    }
  const byRoot = new Map<number, Group>();
  const byId = new Map(contacts.map((c) => [c.id, c]));
  for (const k of keys) {
    const root = uf.find(k.members[0]!.id);
    const g = byRoot.get(root) ?? { key: `${kinds.length > 1 ? 'pe' : kinds[0]![0]}-${root}`, members: [], reasons: [] };
    byRoot.set(root, g);
    g.reasons.push({ kind: k.kind, value: k.value });
    for (const c of k.members) if (!g.members.includes(c)) g.members.push(byId.get(c.id)!);
  }
  return [...byRoot.values()];
}

function nameGroups(contacts: IndexedContact[]): Group[] {
  return [...shared(contacts, (c) => (c.nameKey ? [c.nameKey] : []))].map(([, members]) => ({
    key: `n-${Math.min(...members.map((c) => c.id))}`,
    members: [...members],
    reasons: [{ kind: 'name' as const, value: members[0]!.name }],
  }));
}

const time = (s: string | null) => (s ? Date.parse(s) : 0);
const created = (c: IndexedContact) => (c.createdAt ? Date.parse(c.createdAt) : Number.POSITIVE_INFINITY);
const newest = (g: Group) => Math.max(...g.members.map((c) => time(c.modifiedAt) || time(c.createdAt)));

/** Группы дублей, отсортированные: больше контактов, затем самый свежий modifiedAt. */
export function buildGroups(contacts: IndexedContact[], by: DuplicatesBy): Group[] {
  let groups: Group[];
  if (by === 'phone') groups = linkedGroups(contacts, ['phone']);
  else if (by === 'email') groups = linkedGroups(contacts, ['email']);
  else if (by === 'name') groups = nameGroups(contacts);
  else if (by === 'messenger') groups = linkedGroups(contacts, ['messenger']);
  else {
    groups = linkedGroups(contacts, ['phone', 'email', 'messenger']);
    const owner = new Map<number, Group>();
    for (const g of groups) for (const c of g.members) owner.set(c.id, g);
    for (const ng of nameGroups(contacts)) {
      const home = owner.get(ng.members[0]!.id);
      // Имя целиком внутри группы по телефону/почте — это та же группа, только с ещё одной причиной.
      if (home && ng.members.every((c) => owner.get(c.id) === home)) home.reasons.push(...ng.reasons);
      else groups.push(ng);
    }
  }
  // Самый ранний — первым (его карточка слева, «остальные объединятся с ним»); без даты — в конце.
  for (const g of groups) g.members.sort((a, b) => created(a) - created(b) || a.id - b.id);
  return groups.sort((a, b) => b.members.length - a.members.length || newest(b) - newest(a) || (a.key < b.key ? -1 : 1));
}

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** q — подстрока без регистра по имени, почте; если в q есть цифры — по цифрам телефонов. */
export function matchesQuery(g: Group, q: string): boolean {
  const needle = fold(q.trim());
  if (!needle) return true;
  const digits = needle.replace(/\D/g, '');
  return g.members.some(
    (c) =>
      fold(c.name).includes(needle) ||
      c.emails.some((e) => e.toLowerCase().includes(needle)) ||
      (needle.replace(/^@/, '').length >= 3 && c.messengerKeys.some((k) => k.slice(k.indexOf(':') + 1).includes(needle.replace(/^@/, '')))) ||
      (digits.length > 0 && c.phones.some((p) => p.replace(/\D/g, '').includes(digits) || (normalizeClientPhone(p) ?? '').includes(digits))),
  );
}

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

export function page(groups: Group[], opts: { q?: string; cursor?: string | null; limit?: number }, meta: { scanned: number; builtAt: string }): ContactDuplicatesDto {
  const filtered = opts.q ? groups.filter((g) => matchesQuery(g, opts.q!)) : groups;
  const offset = /^\d+$/.test(opts.cursor ?? '') ? Number(opts.cursor) : 0;
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const slice = filtered.slice(offset, offset + limit);
  return {
    groups: slice.map(toDto),
    total: filtered.length,
    nextCursor: offset + limit < filtered.length ? String(offset + limit) : null,
    scanned: meta.scanned,
    builtAt: meta.builtAt,
  };
}

function toDto(g: Group): DuplicateGroupDto {
  return {
    key: g.key,
    reasons: g.reasons,
    contacts: g.members.map(({ id, name, phones, emails, createdAt, modifiedAt, assignedById, photo, messengers }) => ({
      id,
      name,
      phones,
      emails,
      createdAt,
      modifiedAt,
      assignedById,
      photo: photo ?? null,
      messengers: messengers ?? [],
    })),
  };
}
