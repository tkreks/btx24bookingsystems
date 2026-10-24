import { BadRequestException, Injectable } from '@nestjs/common';
import type { WorkdayAction, WorkdayDto, WorkdayStatus } from '@btx24/shared';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { Bitrix24Error } from '../bitrix24/rest/errors.js';

interface RawWorkday {
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

/**
 * Рабочий день сотрудника — **только свой**: вызовы токеном пользователя и без USER_ID, поэтому
 * чужой день начать или закрыть нельзя. Права портала на учёт времени проверяет Битрикс24.
 */
@Injectable()
export class WorkdayService {
  async status(user: B24UserContext): Promise<WorkdayDto> {
    try {
      return toDto((await user.client.call<RawWorkday>('timeman.status')).result);
    } catch (err) {
      const reason = unavailable(err);
      if (reason) return { available: false, reason, status: null, timeStart: null, duration: null, timeLeaks: null };
      throw err;
    }
  }

  /** `report` — комментарий сотрудника к завершению дня (`timeman.close` REPORT). */
  async act(user: B24UserContext, action: string, report?: unknown): Promise<WorkdayDto> {
    if (action !== 'open' && action !== 'pause' && action !== 'close')
      throw new BadRequestException({ code: 'INVALID_ACTION', message: 'action: open, pause или close' });
    const current = await this.status(user);
    if (!current.available) throw new BadRequestException({ code: 'WORKDAY_UNAVAILABLE', message: current.reason });
    if (current.status && !ALLOWED[current.status].includes(action))
      throw new BadRequestException({ code: 'WRONG_WORKDAY_STATE', message: 'Действие недоступно в текущем статусе рабочего дня' });
    const params: Record<string, unknown> = {};
    // Вчерашний день не закрыт (EXPIRED): закрываем рекомендованным временем с пояснением.
    if (action === 'close' && current.status === 'EXPIRED') {
      const raw = (await user.client.call<RawWorkday>('timeman.status')).result;
      if (raw?.TIME_FINISH_DEFAULT) {
        params.TIME = raw.TIME_FINISH_DEFAULT;
        params.REPORT = 'Рабочий день не был закрыт вовремя — закрыт из приложения бронирования';
      }
    }
    const comment = action === 'close' && typeof report === 'string' ? report.trim().slice(0, 1000) : '';
    if (comment) params.REPORT = comment;
    return toDto((await user.client.call<RawWorkday>(`timeman.${action}`, params)).result);
  }
}

function toDto(r: RawWorkday | undefined): WorkdayDto {
  const status = STATUSES.includes(r?.STATUS as WorkdayStatus) ? (r!.STATUS as WorkdayStatus) : null;
  return {
    available: true,
    reason: null,
    status,
    timeStart: r?.TIME_START ? new Date(r.TIME_START).toISOString() : null,
    duration: r?.DURATION ?? null,
    timeLeaks: r?.TIME_LEAKS ?? null,
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
