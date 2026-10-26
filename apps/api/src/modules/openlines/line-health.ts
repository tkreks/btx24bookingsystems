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
const lines = new Map<string, { value: Map<number, Line>; expiresAt: number }>();
const problems = new Map<string, { value: string | null; expiresAt: number }>();

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
    ref = lineOf((await client.call<{ entity_id?: string }>('imopenlines.dialog.get', { CHAT_ID: chatId })).result?.entity_id);
  } catch {
    return null;
  }
  return ref ? lineProblem(client, prisma, portalId, ref.connector, ref.line) : null;
}

export async function lineProblem(client: Client, prisma: PrismaService | undefined, portalId: string, connector: string, line: number): Promise<string | null> {
  const key = `${portalId}:${connector}:${line}`;
  const hit = problems.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
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
  problems.set(key, { value: problem, expiresAt: Date.now() + TTL });
  return problem;
}

async function portalLines(client: Client, portalId: string): Promise<Map<number, Line> | null> {
  const hit = lines.get(portalId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const r = await client.call<Line[]>('imopenlines.config.list.get', { PARAMS: { select: ['ID', 'LINE_NAME', 'ACTIVE'], limit: 200 } });
    const value = new Map((Array.isArray(r.result) ? r.result : []).map((x) => [Number(x.ID), x]));
    lines.set(portalId, { value, expiresAt: Date.now() + TTL });
    return value;
  } catch {
    return null;
  }
}

/** Для тестов: сбросить кэш. */
export function resetLineHealthCache(): void {
  lines.clear();
  problems.clear();
}

/** «Чат не работает: …» — ошибка ручной отправки сотрудником. */
export function chatNotWorkingMessage(problem: string): string {
  return `Чат с клиентом не работает: ${problem}. Создайте работающий чат с клиентом — сообщения приложения уходят только через рабочие открытые линии`;
}
