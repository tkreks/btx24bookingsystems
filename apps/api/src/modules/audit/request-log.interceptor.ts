import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { catchError, tap, throwError, type Observable } from 'rxjs';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { ActionLogService } from './action-log.service.js';

type Req = { b24?: B24UserContext; method: string; route?: { path?: string }; params?: Record<string, string>; body?: unknown; headers: Record<string, unknown> };

/** Изменяющие запросы сотрудников → журнал действий. `:param` в подписи заменяется значением. */
const LABELS: Record<string, string> = {
  'POST /api/settings-access': 'Ввёл временный пароль к настройкам',
  'POST /api/admin/settings-codes': 'Создал временный пароль к настройкам',
  'DELETE /api/admin/settings-codes/:id': 'Отозвал временный пароль к настройкам',
  'PUT /api/admin/external-users/:id/password': 'Сменил пароль прямой ссылки',
  'POST /api/workday/:action': 'Рабочий день: :action',
  'POST /api/admin/placements/sync': 'Зарегистрировал встройки в Битрикс24',
  'PUT /api/booking-alerts/:id': 'Изменил статус уведомления о брони',
  'POST /api/booking-alerts/:id/resolve': 'Принял решение по уведомлению о брони',
  'PUT /api/admin/booking-sync/deal-fields': 'Изменил системные поля сделки',
  'PUT /api/admin/booking-sync': 'Изменил настройки сверки броней',
  'POST /api/admin/booking-sync/chat': 'Создал чат уведомлений о бронях',
  'PUT /api/admin/resources/:resourceId': 'Изменил имя ресурса #:resourceId для клиента',
  'POST /api/payments': 'Создал счёт и ссылку на оплату',
  'POST /api/openlines/folders': 'Создал папку чатов',
  'PUT /api/openlines/folders/:id': 'Изменил папку чатов',
  'DELETE /api/openlines/folders/:id': 'Удалил папку чатов',
  'PUT /api/openlines/folders/:id/chats/:chatId': 'Положил чат #:chatId в папку',
  'DELETE /api/openlines/folder-chats/:chatId': 'Убрал чат #:chatId из папки',
  'POST /api/openlines/chats/:chatId/join': 'Присоединился к чату #:chatId',
  'POST /api/openlines/chats/:chatId/send': 'Отправил сообщение в чат #:chatId',
  'POST /api/openlines/files': 'Загрузил файл для чата',
  'POST /api/openlines/templates': 'Создал шаблон сообщения',
  'PUT /api/openlines/templates/:id': 'Изменил шаблон сообщения',
  'DELETE /api/openlines/templates/:id': 'Удалил шаблон сообщения',
};

/**
 * Пишутся отдельно, подробно («было → стало», бронь, вход) — здесь пропускаются; предпросмотры
 * шаблонов ничего не меняют.
 */
const SKIP = new Set([
  'POST /api/activity/enter',
  'POST /api/bookings',
  'POST /api/bookings/:bookingId/cancel',
  'PUT /api/deals/:dealId/fields',
  'PUT /api/openlines/chats/:chatId/reply-status',
  'POST /api/admin/groups',
  'PUT /api/admin/groups/:id',
  'DELETE /api/admin/groups/:id',
  'PUT /api/admin/settings',
  'POST /api/openlines/chats/:chatId/render',
  'POST /api/openlines/templates/preview',
]);

/** Объект действия по параметрам маршрута. */
function entityOf(params: Record<string, string>, body: unknown): { entityType: string; entityId: string } | null {
  if (params.chatId) return { entityType: 'chat', entityId: params.chatId };
  if (params.bookingId) return { entityType: 'booking', entityId: params.bookingId };
  if (params.dealId) return { entityType: 'deal', entityId: params.dealId };
  const dealId = (body as { dealId?: unknown } | null)?.dealId;
  if (typeof dealId === 'number') return { entityType: 'deal', entityId: String(dealId) };
  return null;
}

const SECRET = /pass|code|token|secret|auth/i;
/** Тело запроса для журнала: без паролей и кодов, тексты — длиной (переписка с клиентом — персональные данные). */
export function sanitize(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== 'object') return typeof v === 'string' && v.length > 120 ? `[текст, ${v.length} симв.]` : v;
  if (depth > 3) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitize(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) =>
      SECRET.test(k) ? [k, '[скрыто]'] : k === 'text' && typeof x === 'string' ? [k, `[текст, ${x.length} симв.]`] : [k, sanitize(x, depth + 1)],
    ),
  );
}

/**
 * Все изменяющие действия сотрудников (POST/PUT/PATCH/DELETE после `B24AuthGuard`) — в журнал
 * действий, и удачные, и с ошибкой. Глобальный перехватчик: новые маршруты попадают в журнал сами
 * (подпись — «метод путь», пока не добавлена в `LABELS`).
 */
@Injectable()
export class RequestLogInterceptor implements NestInterceptor {
  constructor(private readonly log: ActionLogService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Req>();
    const user = req.b24;
    const route = `${req.method} ${req.route?.path ?? ''}`;
    if (!user || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || SKIP.has(route)) return next.handle();
    const params = req.params ?? {};
    const label = (LABELS[route] ?? route).replace(/:(\w+)/g, (_, k: string) => params[k] ?? `:${k}`);
    const write = (ok: boolean, error?: unknown) =>
      void this.log.user(user, {
        action: 'request',
        summary: ok ? label : `${label} — не удалось`,
        ...entityOf(params, req.body),
        details: {
          route,
          params,
          body: sanitize(req.body),
          ...(ok ? {} : { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }),
        },
        via: String(req.headers['x-btx24-placement'] ?? '') || 'app',
      });
    return next.handle().pipe(
      tap(() => write(true)),
      catchError((e: unknown) => {
        write(false, e);
        return throwError(() => e);
      }),
    );
  }
}
