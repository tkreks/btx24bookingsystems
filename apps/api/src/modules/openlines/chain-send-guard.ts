import { createHash } from 'node:crypto';
import { ConflictException, Logger } from '@nestjs/common';
import type { SendResultDto, TemplateStepDto } from '@btx24/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';

/**
 * Защита отправки цепочки от повтора (двойной клик, ретрай после таймаута) по ключу клиента
 * `idempotencyKey` в пределах портала и сотрудника.
 *
 * Без отдельной таблицы (миграции нет): два слоя.
 * 1. Память процесса api — запрос с тем же ключом, пока первый идёт или недавно завершился
 *    (`MEMORY_TTL_MS`), получает тот же результат (тот же Promise), без второй отправки.
 * 2. Журнал действий (`ActionLog`, только добавление): строка `chat.send_chain` «начата» — перед
 *    первым сообщением, «завершена» с результатом — после. Повтор после перезапуска api получает
 *    сохранённый результат; «начата» без «завершена» — 409 `CHAIN_SEND_UNKNOWN` (клиент мог получить
 *    часть цепочки, повторно не шлём).
 *
 * Ограничения: в журнале нет уникального индекса по ключу — при нескольких репликах api два
 * одновременных запроса с одним ключом на разных репликах могут пройти оба (сейчас api — один
 * процесс). Поиск в журнале — за `LOOKUP_WINDOW_MS`.
 */
export const CHAIN_ACTION = 'chat.send_chain';
const MEMORY_TTL_MS = 15 * 60_000;
const MEMORY_MAX = 5000;
export const LOOKUP_WINDOW_MS = 24 * 3600_000;

interface Entry {
  fingerprint: string;
  promise: Promise<SendResultDto>;
  doneAt: number | null;
}

interface Logged {
  state?: unknown;
  fingerprint?: unknown;
  result?: unknown;
}

const reused = () =>
  new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'Ключ отправки уже использован для другой цепочки или чата' });

/** Отпечаток запроса: тот же ключ с другим чатом или другими шагами — ошибка клиента, не повтор. */
export function chainFingerprint(chatId: number, steps: TemplateStepDto[]): string {
  return createHash('sha256').update(JSON.stringify({ chatId, steps: steps.map((s) => [s.text, s.fileIds]) })).digest('hex');
}

export class ChainSendGuard {
  private readonly logger = new Logger(ChainSendGuard.name);
  private readonly entries = new Map<string, Entry>();
  now = () => Date.now();

  constructor(private readonly prisma?: PrismaService) {}

  /**
   * Выполнить `run` не больше одного раза на ключ. `run(markStarted)` обязан вызвать `markStarted()`
   * прямо перед первым сообщением клиенту: до этого момента сбой (проверка линии, файлы) повтор с тем
   * же ключом не блокирует.
   */
  run(
    user: B24UserContext,
    chatId: number,
    key: string,
    fingerprint: string,
    run: (markStarted: () => Promise<void>) => Promise<SendResultDto>,
  ): Promise<SendResultDto> {
    this.evict();
    const id = `${user.portal.id}:${user.userId}:${key}`;
    const known = this.entries.get(id);
    if (known) {
      if (known.fingerprint !== fingerprint) return Promise.reject(reused());
      return known.promise;
    }
    // Запись в карту — синхронно, до первого await: одновременный дубль ждёт этот же Promise.
    const entry: Entry = { fingerprint, doneAt: null, promise: Promise.resolve(null as unknown as SendResultDto) };
    entry.promise = (async () => {
      const prev = await this.lookup(user, key);
      if (prev) {
        if (prev.fingerprint !== fingerprint) throw reused();
        if (prev.result) return prev.result;
        throw new ConflictException({
          code: 'CHAIN_SEND_UNKNOWN',
          message: 'Эта цепочка уже отправлялась, но результат неизвестен — проверьте ленту чата, прежде чем отправлять снова',
        });
      }
      const result = await run(() => this.log(user, chatId, key, { state: 'started', fingerprint }, `Цепочка сообщений в чат #${chatId}: начата отправка`, true));
      await this.log(
        user,
        chatId,
        key,
        { state: 'finished', fingerprint, result },
        `Цепочка сообщений в чат #${chatId}: ${result.error ? `ошибка на шаге ${result.error.step + 1}, ушло шагов: ${result.sent}` : `отправлено шагов: ${result.sent}`}`,
        false,
      );
      return result;
    })();
    this.entries.set(id, entry);
    entry.promise.then(
      () => (entry.doneAt = this.now()),
      // Ошибка: отправка не началась (повтор можно) или результат неизвестен — тогда в журнале
      // осталась «начата», и повтор получит 409 из журнала.
      () => this.entries.delete(id),
    );
    return entry.promise;
  }

  private evict(): void {
    const t = this.now();
    for (const [id, e] of this.entries) if (e.doneAt !== null && t - e.doneAt > MEMORY_TTL_MS) this.entries.delete(id);
    if (this.entries.size <= MEMORY_MAX) return;
    for (const [id, e] of this.entries) {
      if (this.entries.size <= MEMORY_MAX) break;
      if (e.doneAt !== null) this.entries.delete(id);
    }
  }

  private async lookup(user: B24UserContext, key: string): Promise<{ fingerprint: string; result: SendResultDto | null } | null> {
    if (!this.prisma) return null;
    const rows = await this.prisma.actionLog.findMany({
      where: {
        portalId: user.portal.id,
        userId: user.userId,
        action: CHAIN_ACTION,
        at: { gte: new Date(this.now() - LOOKUP_WINDOW_MS) },
        details: { path: '$.idempotencyKey', equals: key },
      },
      orderBy: { at: 'desc' },
      take: 5,
      select: { details: true },
    });
    if (!rows.length) return null;
    const details = rows.map((r) => (r.details ?? {}) as Logged);
    const finished = details.find((d) => d.state === 'finished' && d.result && typeof d.result === 'object');
    return { fingerprint: String(details[0].fingerprint ?? ''), result: (finished?.result as SendResultDto | undefined) ?? null };
  }

  /** `strict` — сбой записи прерывает отправку (без «начата» повтор не распознать). */
  private async log(user: B24UserContext, chatId: number, key: string, details: Record<string, unknown>, summary: string, strict: boolean): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.actionLog.create({
        data: {
          portalId: user.portal.id,
          actorKind: 'user',
          userId: user.userId,
          actorName: (user.userName ?? '').slice(0, 255) || null,
          action: CHAIN_ACTION,
          entityType: 'chat',
          entityId: String(chatId),
          summary: summary.slice(0, 500),
          details: { idempotencyKey: key, ...details } as Prisma.InputJsonValue,
          via: 'app',
        },
      });
    } catch (e) {
      if (strict) throw e;
      this.logger.warn(`chain send log failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
