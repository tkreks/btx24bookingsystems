import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { WorkdayAction, WorkdayDto, WorkdayStatus } from '@btx24/shared';
import type { WorkdayState } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error, RATE_LIMIT_CODES } from '../bitrix24/rest/errors.js';

export interface RawWorkday {
  STATUS?: string;
  TIME_START?: string | null;
  DURATION?: string | null;
  TIME_LEAKS?: string | null;
  TIME_FINISH_DEFAULT?: string | null;
}

const STATUSES: WorkdayStatus[] = ['OPENED', 'PAUSED', 'CLOSED', 'EXPIRED'];
/** Что можно сделать из каждого статуса (как кнопки рабочего дня в Битрикс24). */
const ALLOWED: Record<WorkdayStatus, WorkdayAction[]> = {
  CLOSED: ['open'],
  OPENED: ['pause', 'close'],
  PAUSED: ['open', 'close'],
  EXPIRED: ['close'],
};
const NEXT: Record<WorkdayAction, WorkdayStatus> = { open: 'OPENED', pause: 'PAUSED', close: 'CLOSED' };
/** Старше — сверяем с Битрикс24 (в фоне, ответ — из базы приложения). */
export const WORKDAY_STALE_MS = 20_000;

/** Битрикс24 недоступен (сеть, 5xx, лимит) — действие приложения остаётся и передаётся позже. */
const offline = (err: unknown) => !(err instanceof Bitrix24Error) || (err.httpStatus ?? 0) >= 500 || RATE_LIMIT_CODES.has(err.code);
const statusOf = (v: unknown): WorkdayStatus | null => (STATUSES.includes(v as WorkdayStatus) ? (v as WorkdayStatus) : null);
/** Событие истории по переходу статуса: продолжить после паузы — `resume`. */
function eventAction(from: string | null, to: WorkdayStatus): 'open' | 'pause' | 'resume' | 'close' | null {
  if (to === 'OPENED') return from === 'PAUSED' ? 'resume' : 'open';
  if (to === 'PAUSED') return 'pause';
  if (to === 'CLOSED') return 'close';
  return null;
}

/**
 * Рабочий день сотрудника — **только свой**: вызовы токеном пользователя и без USER_ID, поэтому
 * чужой день начать или закрыть нельзя. Права портала на учёт времени проверяет Битрикс24.
 *
 * Состояние хранится в базе приложения (`WorkdayState`, история — `WorkdayEvent`): ответ — сразу из
 * базы, сверка с `timeman.status` — когда данные старше 20 с. Действие приложения применяется у нас и
 * сразу уходит в Битрикс24; Битрикс24 недоступен — `pendingAction`, повтор при следующей сверке.
 * Изменение в Битрикс24 (день закрыли там) применяется в приложении при сверке (и из «Кто на смене?»).
 */
@Injectable()
export class WorkdayService {
  private readonly logger = new Logger(WorkdayService.name);
  private readonly syncing = new Map<string, Promise<WorkdayDto>>();

  constructor(private readonly prisma: PrismaService) {}

  private row(user: B24UserContext) {
    return this.prisma.workdayState.findUnique({ where: { portalId_userId: { portalId: user.portal.id, userId: user.userId } } });
  }

  async status(user: B24UserContext): Promise<WorkdayDto> {
    const row = await this.row(user);
    if (!row) return this.sync(user);
    if (row.pendingAction || !row.syncedAt || Date.now() - row.syncedAt.getTime() > WORKDAY_STALE_MS)
      void this.sync(user).catch((err: unknown) => this.logger.warn(`workday sync ${user.userId}: ${err instanceof Error ? err.message : String(err)}`));
    return toDto(row);
  }

  /** Сверка с Битрикс24: сначала передать своё непереданное действие, потом принять состояние портала. */
  sync(user: B24UserContext): Promise<WorkdayDto> {
    const key = `${user.portal.id}:${user.userId}`;
    const running = this.syncing.get(key);
    if (running) return running;
    const p = this.doSync(user).finally(() => this.syncing.delete(key));
    this.syncing.set(key, p);
    return p;
  }

  private async doSync(user: B24UserContext): Promise<WorkdayDto> {
    let row = await this.row(user);
    if (row?.pendingAction) {
      const pushed = await this.push(user, row);
      if (pushed) return pushed;
      row = await this.row(user);
      if (row?.pendingAction) return toDto(row);
    }
    let raw: RawWorkday | undefined;
    try {
      raw = (await user.client.call<RawWorkday>('timeman.status')).result;
    } catch (err) {
      const reason = unavailable(err);
      if (reason) return { available: false, reason, status: null, timeStart: null, duration: null, timeLeaks: null };
      if (row && offline(err)) return toDto(await this.prisma.workdayState.update({ where: { id: row.id }, data: { syncError: errText(err) } }));
      throw err;
    }
    return toDto(await this.applyBitrix(user.portal.id, user.userId, raw));
  }

  /**
   * Состояние из Битрикс24 → в приложение. Статус изменился там (начали, закрыли день в Битрикс24) —
   * запись в истории с `source: bitrix`. Непереданное действие приложения не перетирается.
   */
  async applyBitrix(portalId: string, userId: number, raw: RawWorkday | undefined, source: 'app' | 'bitrix' = 'bitrix'): Promise<WorkdayState> {
    const status = statusOf(raw?.STATUS) ?? 'CLOSED';
    const now = new Date();
    const prev = await this.prisma.workdayState.findUnique({ where: { portalId_userId: { portalId, userId } } });
    if (prev?.pendingAction) return prev;
    const fields = {
      status,
      timeStart: raw?.TIME_START ? new Date(raw.TIME_START) : null,
      duration: raw?.DURATION ?? null,
      timeLeaks: raw?.TIME_LEAKS ?? null,
      syncedAt: now,
      syncError: null,
    };
    const changed = !prev || prev.status !== status;
    const row = await this.prisma.workdayState.upsert({
      where: { portalId_userId: { portalId, userId } },
      create: { portalId, userId, ...fields, source, changedAt: now },
      update: { ...fields, ...(changed ? { source, changedAt: now } : {}) },
    });
    const action = changed && prev && source === 'bitrix' ? eventAction(prev.status, status) : null;
    if (action) await this.prisma.workdayEvent.create({ data: { portalId, userId, action, status, source, at: now } });
    return row;
  }

  /** `report` — комментарий сотрудника к завершению дня (`timeman.close` REPORT). */
  async act(user: B24UserContext, action: string, report?: unknown): Promise<WorkdayDto> {
    if (action !== 'open' && action !== 'pause' && action !== 'close')
      throw new BadRequestException({ code: 'INVALID_ACTION', message: 'action: open, pause или close' });
    let row = await this.row(user);
    // Свежее состояние — чтобы не действовать по устаревшему (день могли закрыть в Битрикс24).
    if (!row || (!row.pendingAction && (!row.syncedAt || Date.now() - row.syncedAt.getTime() > WORKDAY_STALE_MS))) {
      const current = await this.sync(user);
      if (!current.available) throw new BadRequestException({ code: 'WORKDAY_UNAVAILABLE', message: current.reason });
      row = await this.row(user);
    }
    const status = statusOf(row?.status);
    if (!row || !status || !ALLOWED[status].includes(action))
      throw new BadRequestException({ code: 'WRONG_WORKDAY_STATE', message: 'Действие недоступно в текущем статусе рабочего дня' });
    const comment = action === 'close' && typeof report === 'string' ? report.trim().slice(0, 1000) : '';
    const next = NEXT[action];
    const now = new Date();
    // Сначала — у нас (приложение работает и без Битрикс24), затем — в Битрикс24.
    const local = await this.prisma.workdayState.update({
      where: { id: row.id },
      data: {
        status: next,
        ...(action === 'open' && status === 'CLOSED' ? { timeStart: now, duration: null, timeLeaks: null } : {}),
        source: 'app',
        changedAt: now,
        pendingAction: action,
        pendingReport: comment || null,
      },
    });
    const event = await this.prisma.workdayEvent.create({
      data: { portalId: user.portal.id, userId: user.userId, action: eventAction(status, next) ?? action, status: next, source: 'app', report: comment || null, at: now },
    });
    // Действие отклонено Битрикс24 — вернуть его состояние и убрать запись истории.
    const pushed = await this.push(user, { ...local, status }, event.id);
    return pushed ?? toDto((await this.row(user)) ?? local);
  }

  /**
   * Передать действие приложения в Битрикс24. Успех — состояние портала; Битрикс24 недоступен — null
   * (действие ждёт следующей сверки); отказ портала — состояние портала и ошибка сотруднику.
   * `row.status` — статус **до** действия (для закрытия незакрытого прошлого дня).
   */
  private async push(user: B24UserContext, row: WorkdayState, eventId?: string): Promise<WorkdayDto | null> {
    const action = row.pendingAction as WorkdayAction;
    const params: Record<string, unknown> = {};
    try {
      // Вчерашний день не закрыт (EXPIRED): закрываем рекомендованным временем с пояснением.
      if (action === 'close' && row.status === 'EXPIRED') {
        const raw = (await user.client.call<RawWorkday>('timeman.status')).result;
        if (raw?.TIME_FINISH_DEFAULT) {
          params.TIME = raw.TIME_FINISH_DEFAULT;
          params.REPORT = 'Рабочий день не был закрыт вовремя — закрыт из приложения бронирования';
        }
      }
      if (action === 'close' && row.pendingReport) params.REPORT = row.pendingReport;
      const raw = (await user.client.call<RawWorkday>(`timeman.${action}`, params)).result;
      await this.prisma.workdayState.update({ where: { id: row.id }, data: { pendingAction: null, pendingReport: null } });
      return toDto(await this.applyBitrix(user.portal.id, user.userId, raw, 'app'));
    } catch (err) {
      if (offline(err)) {
        await this.prisma.workdayState.update({ where: { id: row.id }, data: { syncError: errText(err) } });
        return null;
      }
      await this.prisma.workdayState.update({ where: { id: row.id }, data: { pendingAction: null, pendingReport: null, syncError: errText(err) } });
      if (eventId) await this.prisma.workdayEvent.deleteMany({ where: { id: eventId } });
      await user.client
        .call<RawWorkday>('timeman.status')
        .then((r) => this.applyBitrix(user.portal.id, user.userId, r.result))
        .catch(() => undefined);
      const reason = unavailable(err);
      throw new BadRequestException({ code: 'WORKDAY_REJECTED', message: reason ?? `Битрикс24 не принял действие: ${errText(err)}` });
    }
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

function toDto(r: WorkdayState): WorkdayDto {
  return {
    available: true,
    reason: null,
    status: statusOf(r.status),
    timeStart: r.timeStart ? r.timeStart.toISOString() : null,
    duration: r.duration,
    timeLeaks: r.timeLeaks,
    ...(r.pendingAction ? { pending: true } : {}),
  };
}

/** Учёт времени недоступен — причина для людей; иная ошибка — null (пробрасываем). */
function unavailable(err: unknown): string | null {
  if (!(err instanceof Bitrix24Error)) return null;
  const s = `${err.code} ${err.message}`;
  if (/insufficient_scope/i.test(s)) return 'Приложению не выдано право «Учёт рабочего времени» (timeman)';
  if (/TIMEMAN_TOOL_DISABLED/i.test(s)) return 'Учёт рабочего времени выключен на портале';
  return null;
}
