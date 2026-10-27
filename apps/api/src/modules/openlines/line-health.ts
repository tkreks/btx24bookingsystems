import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Сообщения приложения клиенту — только через рабочие открытые линии (решение владельца 2026-10-26).
 * Рабочая: линия включена (`imopenlines.config.list.get`, ACTIVE=Y), её канал подключён
 * (`imconnector.status`: CONFIGURED и STATUS, без ERROR), у своего номера приложения — сессия `ready`.
 * Не удалось узнать (ошибка REST, нет `entity_id`) — не блокируем: отправка сама вернёт ошибку.
 */
export const NO_WORKING_CHAT = 'Нет рабочего чата с клиентом в открытой линии — создайте работающий чат с клиентом';

type Client = { call<T>(method: string, params?: Record<string, unknown>): Promise<{ result?: T }> };
type Line = { ID: string | number; LINE_NAME?: string; ACTIVE?: string };

const TTL = 2 * 60_000;
/** Старше TTL, но моложе этого — отдаём сразу и перепроверяем в фоне (список чатов не ждёт портал). */
const STALE_TTL = 60 * 60_000;
/** Линия чата не меняется: `entity_id` спрашиваем у портала один раз в сутки. */
const REF_TTL = 24 * 60 * 60_000;
type Entry<T> = { value: Promise<T>; at: number; refreshing?: boolean };
const lines = new Map<string, Entry<Map<number, Line> | null>>();
const problems = new Map<string, Entry<string | null>>();
const refs = new Map<string, Entry<ReturnType<typeof lineOf>>>();

/**
 * Кэш с перепроверкой в фоне: свежее — как есть; устаревшее (до `STALE_TTL`) — сразу, а запрос к
 * порталу уходит в фоне; одновременные запросы ждут один и тот же ответ.
 */
function cached<T>(map: Map<string, Entry<T>>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = map.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && (age < ttl || hit.refreshing)) return hit.value;
  if (map.size > 5000) map.clear();
  if (hit && age < Math.max(ttl, STALE_TTL)) {
    hit.refreshing = true;
    const value = load();
    value.then(
      () => map.set(key, { value, at: Date.now() }),
      () => (hit.refreshing = false),
    );
    return hit.value;
  }
  const value = load();
  map.set(key, { value, at: Date.now() });
  value.catch(() => map.get(key)?.value === value && map.delete(key));
  return value;
}

/** Канал и линия чата из `entity_id` (`<connector>|<line>|<chat>|<user>`). */
export function lineOf(entityId: string | null | undefined): { connector: string; line: number } | null {
  const [connector = '', line = ''] = String(entityId ?? '').split('|');
  const n = Number(line);
  return connector && Number.isSafeInteger(n) && n > 0 ? { connector, line: n } : null;
}

/** Почему чат не годится для отправки; null — рабочий (или проверить не удалось). */
export async function chatLineProblem(client: Client, prisma: PrismaService | undefined, portalId: string, chatId: number): Promise<string | null> {
  let ref: ReturnType<typeof lineOf> = null;
  try {
    ref = await cached(refs, `${portalId}:${chatId}`, REF_TTL, async () =>
      lineOf((await client.call<{ entity_id?: string }>('imopenlines.dialog.get', { CHAT_ID: chatId })).result?.entity_id),
    );
  } catch {
    return null;
  }
  return ref ? lineProblem(client, prisma, portalId, ref.connector, ref.line) : null;
}

export function lineProblem(client: Client, prisma: PrismaService | undefined, portalId: string, connector: string, line: number): Promise<string | null> {
  return cached(problems, `${portalId}:${connector}:${line}`, TTL, () => checkLine(client, prisma, portalId, connector, line));
}

async function checkLine(client: Client, prisma: PrismaService | undefined, portalId: string, connector: string, line: number): Promise<string | null> {
  const l = (await portalLines(client, portalId))?.get(line);
  const name = l?.LINE_NAME || `#${line}`;
  let problem: string | null = l && l.ACTIVE !== 'Y' ? `линия «${name}» выключена` : null;
  if (!problem)
    try {
      const s = (await client.call<{ CONFIGURED?: boolean; STATUS?: boolean; ERROR?: boolean }>('imconnector.status', { CONNECTOR: connector, LINE: line })).result;
      if (s && (s.ERROR === true || s.CONFIGURED === false || s.STATUS === false)) problem = `канал линии «${name}» не подключён`;
    } catch {
      /* статус не узнали — не блокируем */
    }
  if (!problem && connector.startsWith('btx24_') && prisma) {
    try {
      const m = await prisma.messenger.findFirst({ where: { portalId, lineMode: 'own', lineId: line }, select: { state: true } });
      if (m && m.state !== 'ready') problem = `номер линии «${name}» не подключён`;
    } catch {
      /* без базы — по статусу коннектора */
    }
  }
  return problem;
}

function portalLines(client: Client, portalId: string): Promise<Map<number, Line> | null> {
  return cached(lines, portalId, TTL, async () => {
    try {
      const r = await client.call<Line[]>('imopenlines.config.list.get', { PARAMS: { select: ['ID', 'LINE_NAME', 'ACTIVE'], limit: 200 } });
      return new Map((Array.isArray(r.result) ? r.result : []).map((x) => [Number(x.ID), x]));
    } catch {
      return null;
    }
  });
}

/** Для тестов: сбросить кэш. */
export function resetLineHealthCache(): void {
  lines.clear();
  problems.clear();
  refs.clear();
}

/** «Чат не работает: …» — ошибка ручной отправки сотрудником. */
export function chatNotWorkingMessage(problem: string): string {
  return `Чат с клиентом не работает: ${problem}. Создайте работающий чат с клиентом — сообщения приложения уходят только через рабочие открытые линии`;
}
