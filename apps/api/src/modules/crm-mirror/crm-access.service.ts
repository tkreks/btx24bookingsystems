import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { LIST_METHOD } from './crm-rows.js';

/** Ответ о видимости старше этого — перепроверяется в фоне (показ при этом — по прежнему ответу). */
export const CRM_ACCESS_TTL_MS = 5 * 60_000;
/** Ответы старше этого удаляются (worker): вернувшийся через месяц сотрудник подождёт первую проверку. */
export const CRM_ACCESS_KEEP_MS = 30 * 86_400_000;
const PAGE = 50;
/** Записей одного сотрудника в памяти процесса — больше не держим (остальное — в базе). */
const MAX_PER_USER = 50_000;

type Check = { ok: boolean; at: number };
type Ref = { typeId: number; id: number };

/**
 * Что из копии CRM (ADR 0013) показать сотруднику — решает Битрикс24 его правами: те же списочные
 * методы его токеном, только `select: ['ID']` по номерам (50 номеров в команде, 50 команд в пакете).
 *
 * Ответы хранятся (`CrmAccessCheck`, решение владельца 2026-10-24): вернувшийся через несколько дней
 * сотрудник сразу видит данные по последним ответам, а ответы старше 5 минут перепроверяются **в фоне**
 * его токеном, пока он работает в приложении. Ждём портал только для записей, которых сотрудник ещё не
 * проверял. Ошибка проверки — запись не видна и ответ не запоминается.
 */
@Injectable()
export class CrmAccessService {
  private readonly logger = new Logger(CrmAccessService.name);
  private readonly checks = new Map<string, Map<string, Check>>();
  /** Идёт фоновая перепроверка сотрудника — вторую не запускаем, новые устаревшие ждут следующего обращения. */
  private readonly refreshing = new Set<string>();
  /** Часы (подменяются в тестах). */
  now: () => number = () => Date.now();

  constructor(private readonly prisma: PrismaService) {}

  /** Видимые сотруднику записи типа `typeId` (1 лид, 2 сделка, 3 контакт, 4 компания) из `ids`. */
  async visible(user: B24UserContext, typeId: number, ids: Iterable<number>): Promise<Set<number>> {
    return (await this.visibleMany(user, [...ids].map((id) => ({ typeId, id })))).get(typeId) ?? new Set();
  }

  /** То же для записей разных типов. Тип без метода списка — не виден. */
  async visibleMany(user: B24UserContext, refs: Ref[]): Promise<Map<number, Set<number>>> {
    const out = new Map<number, Set<number>>();
    const add = (typeId: number, id: number) => (out.get(typeId) ?? out.set(typeId, new Set()).get(typeId)!).add(id);
    const wanted = uniqueRefs(refs).filter((r) => LIST_METHOD[r.typeId]);
    const known = await this.load(user, wanted);
    const now = this.now();
    const unknown: Ref[] = [];
    const stale: Ref[] = [];
    for (const r of wanted) {
      const c = known.get(key(r));
      if (!c) {
        unknown.push(r);
        continue;
      }
      if (c.ok) add(r.typeId, r.id);
      if (now - c.at >= CRM_ACCESS_TTL_MS) stale.push(r);
    }
    if (unknown.length) for (const r of await this.check(user, unknown)) add(r.typeId, r.id);
    if (stale.length) this.refreshLater(user, stale);
    return out;
  }

  /** Перепроверить в фоне (ответ сотруднику не ждёт). */
  private refreshLater(user: B24UserContext, refs: Ref[]): void {
    const k = userKey(user);
    if (this.refreshing.has(k)) return;
    this.refreshing.add(k);
    void this.check(user, refs)
      .catch((err: unknown) => this.logger.warn(`access refresh ${k}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.refreshing.delete(k));
  }

  /** Спросить портал токеном сотрудника; запомнить в памяти и в базе. Возвращает видимые. */
  private async check(user: B24UserContext, refs: Ref[]): Promise<Ref[]> {
    const commands: Record<string, { method: string; params: Record<string, unknown> }> = {};
    const asked = new Map<string, { typeId: number; ids: number[] }>();
    const byType = new Map<number, number[]>();
    for (const r of refs) (byType.get(r.typeId) ?? byType.set(r.typeId, []).get(r.typeId)!).push(r.id);
    for (const [typeId, ids] of byType)
      for (let i = 0; i < ids.length; i += PAGE) {
        const k = `t${typeId}_${i / PAGE}`;
        const part = ids.slice(i, i + PAGE);
        commands[k] = { method: LIST_METHOD[typeId], params: { filter: { '@ID': part }, select: ['ID'] } };
        asked.set(k, { typeId, ids: part });
      }
    const res = await user.client.batch(commands);
    const at = this.now();
    const mem = this.userChecks(user);
    const answers: { typeId: number; id: number; ok: boolean }[] = [];
    for (const [k, { typeId, ids }] of asked) {
      if (res.errors[k]) continue; // Не знаем — не показываем и не запоминаем.
      const rows = res.result[k];
      const seen = new Set((Array.isArray(rows) ? (rows as { ID?: unknown }[]) : []).map((r) => Number(r.ID)));
      for (const id of ids) {
        mem.set(key({ typeId, id }), { ok: seen.has(id), at });
        answers.push({ typeId, id, ok: seen.has(id) });
      }
    }
    if (mem.size > MAX_PER_USER) for (const k of [...mem.keys()].slice(0, mem.size - MAX_PER_USER)) mem.delete(k);
    await this.save(user, answers, new Date(at)).catch((err: unknown) => this.logger.warn(`access save: ${err instanceof Error ? err.message : String(err)}`));
    return answers.filter((a) => a.ok);
  }

  /** Ответы из памяти, недостающие — из базы (и в память). */
  private async load(user: B24UserContext, refs: Ref[]): Promise<Map<string, Check>> {
    const mem = this.userChecks(user);
    const missing = refs.filter((r) => !mem.has(key(r)));
    const byType = new Map<number, number[]>();
    for (const r of missing) (byType.get(r.typeId) ?? byType.set(r.typeId, []).get(r.typeId)!).push(r.id);
    for (const [typeId, ids] of byType)
      for (let i = 0; i < ids.length; i += 1000) {
        const rows = await this.prisma.crmAccessCheck.findMany({
          where: { portalId: user.portal.id, userId: user.userId, entityTypeId: typeId, entityId: { in: ids.slice(i, i + 1000) } },
          select: { entityId: true, allowed: true, checkedAt: true },
        });
        for (const r of rows) mem.set(key({ typeId, id: r.entityId }), { ok: r.allowed, at: r.checkedAt.getTime() });
      }
    return mem;
  }

  private async save(user: B24UserContext, answers: { typeId: number; id: number; ok: boolean }[], at: Date): Promise<void> {
    for (let i = 0; i < answers.length; i += 500) {
      const values = answers.slice(i, i + 500).map((a) => Prisma.sql`(${user.portal.id}, ${user.userId}, ${a.typeId}, ${a.id}, ${a.ok}, ${at})`);
      await this.prisma.$executeRaw`INSERT INTO \`CrmAccessCheck\` (\`portalId\`, \`userId\`, \`entityTypeId\`, \`entityId\`, \`allowed\`, \`checkedAt\`) VALUES ${Prisma.join(values)} ON DUPLICATE KEY UPDATE \`allowed\` = VALUES(\`allowed\`), \`checkedAt\` = VALUES(\`checkedAt\`)`;
    }
  }

  /** Забыть ответы портала (память и база) — например, после смены прав в приложении. */
  async forget(portalId: string, userId?: number): Promise<void> {
    for (const k of this.checks.keys()) if (k === `${portalId}|${userId}` || (userId === undefined && k.startsWith(`${portalId}|`))) this.checks.delete(k);
    await this.prisma.crmAccessCheck.deleteMany({ where: { portalId, ...(userId === undefined ? {} : { userId }) } });
  }

  private userChecks(user: B24UserContext): Map<string, Check> {
    const k = userKey(user);
    return this.checks.get(k) ?? this.checks.set(k, new Map()).get(k)!;
  }
}

const key = (r: Ref) => `${r.typeId}:${r.id}`;
const userKey = (user: B24UserContext) => `${user.portal.id}|${user.userId}`;

function uniqueRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((r) => r.id > 0 && !seen.has(key(r)) && !!seen.add(key(r)));
}
