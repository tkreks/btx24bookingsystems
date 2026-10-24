import { ForbiddenException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { bookingSummary, BookingJournalService, SYSTEM } from '../bookings/booking-journal.service.js';
import { ActionLogService, diffFields } from './action-log.service.js';
import { RequestLogInterceptor, sanitize } from './request-log.interceptor.js';

const user = { portal: { id: 'p1', timezone: 'Europe/Moscow' }, userId: 7, userName: 'Анна' };

describe('журнал действий', () => {
  it('формулировки о бронях: сотрудник, система по неоплате, Битрикс24', () => {
    const r = { bookingId: 555, title: 'Иванов', dealId: 678 };
    expect(bookingSummary(r, 'created', { kind: 'user', userId: 7, name: 'Анна' }, {})).toBe('Создал бронь #555 «Иванов» (сделка #678)');
    expect(bookingSummary(r, 'cancelled', SYSTEM.paymentTimeout, { reason: 'payment_timeout' })).toBe(
      'Бронь #555 «Иванов» (сделка #678): не оплачена в срок — снята автоматически',
    );
    expect(bookingSummary(r, 'cancelled', { kind: 'user', userId: 7, name: 'Анна' }, { reason: 'manual', comment: 'передумал' })).toBe(
      'Снял бронь #555 «Иванов» (сделка #678) — «передумал»',
    );
    expect(bookingSummary({ bookingId: 9, title: null, dealId: null }, 'imported', SYSTEM.bitrix, null)).toBe('Бронь #9: найдена в Битрикс24 (создана там)');
  });

  it('история брони дублируется в журнал действий — в т.ч. снятие системой по неоплате', async () => {
    const record = { id: 'r1', portalId: 'p1', bookingId: 555, title: 'Иванов', dealId: 678, status: 'active', startsAt: new Date(), endsAt: new Date(), resourceIds: [10] };
    const prisma = {
      bookingRecord: { updateMany: vi.fn(async () => ({ count: 1 })), findUnique: vi.fn(async () => record) },
      bookingHistory: { create: vi.fn(async () => ({})) },
    } as unknown as PrismaService;
    const actions = { log: vi.fn(async () => undefined) } as unknown as ActionLogService;
    await new BookingJournalService(prisma, actions).recordCancelled('p1', 555, { reason: 'payment_timeout', actor: SYSTEM.paymentTimeout, via: 'worker' });
    expect(actions.log).toHaveBeenCalledWith('p1', SYSTEM.paymentTimeout, expect.objectContaining({
      action: 'booking.cancelled',
      entityType: 'booking',
      entityId: 555,
      summary: 'Бронь #555 «Иванов» (сделка #678): не оплачена в срок — снята автоматически',
      via: 'worker',
    }));
  });

  it('тело запроса — без паролей и текстов сообщений', () => {
    expect(sanitize({ password: '123', code: 'x', text: 'Здравствуйте, Анна', dealId: 678, nested: { token: 't' } })).toEqual({
      password: '[скрыто]',
      code: '[скрыто]',
      text: '[текст, 18 симв.]',
      dealId: 678,
      nested: { token: '[скрыто]' },
    });
  });

  it('diffFields — только изменившееся, с подписями', () => {
    expect(diffFields({ a: 1, b: [1, 2], c: 'x' }, { a: 1, b: [1, 3], c: 'x', d: true }, { b: 'ресурсы' })).toEqual([
      { field: 'b', label: 'ресурсы', before: [1, 2], after: [1, 3] },
      { field: 'd', label: 'd', before: null, after: true },
    ]);
  });

  describe('RequestLogInterceptor', () => {
    const ctx = (method: string, path: string, params: Record<string, string> = {}, body: unknown = {}) =>
      ({
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => ({ b24: user, method, route: { path }, params, body, headers: {} }) }),
      }) as unknown as ExecutionContext;
    const setup = () => {
      const log = { user: vi.fn(async () => undefined) } as unknown as ActionLogService;
      return { log, i: new RequestLogInterceptor(log) };
    };

    it('изменяющий запрос — подписью для людей, с объектом; ошибка — тоже', async () => {
      const { log, i } = setup();
      await lastValueFrom(i.intercept(ctx('POST', '/api/openlines/chats/:chatId/send', { chatId: '50580' }, { text: 'Привет' }), { handle: () => of('ok') } as CallHandler));
      expect(log.user).toHaveBeenCalledWith(user, expect.objectContaining({ summary: 'Отправил сообщение в чат #50580', entityType: 'chat', entityId: '50580' }));
      await expect(
        lastValueFrom(i.intercept(ctx('PUT', '/api/booking-alerts/:id', { id: 'a1' }), { handle: () => throwError(() => new Error('нет права')) } as CallHandler)),
      ).rejects.toThrow('нет права');
      expect(log.user).toHaveBeenLastCalledWith(user, expect.objectContaining({ summary: 'Изменил статус уведомления о брони — не удалось' }));
    });

    it('ошибка отдельно логируемой записи сохраняется и содержит HTTP статус', async () => {
      const { log, i } = setup();
      await expect(lastValueFrom(i.intercept(ctx('PUT', '/api/admin/groups/:id'), { handle: () => throwError(() => new ForbiddenException('нет права')) } as CallHandler))).rejects.toThrow();
      expect(log.user).toHaveBeenCalledWith(user, expect.objectContaining({ action: 'request', details: expect.objectContaining({ httpStatus: 403, error: 'нет права' }) }));
    });

    it('результат отправки с частичной ошибкой HTTP200 не выдаётся за успех', async () => {
      const { log, i } = setup();
      await lastValueFrom(i.intercept(ctx('POST', '/api/openlines/chats/:chatId/send', {chatId:'99'}), {handle:()=>of({sent:1,messageIds:[101],error:{code:'FAIL',message:'Файл не отправлен'}})} as CallHandler));
      expect(log.user).toHaveBeenCalledWith(user,expect.objectContaining({summary:expect.stringContaining('не удалось'),details:expect.objectContaining({messageIds:[101],error:'Файл не отправлен'})}));
    });

    it('чтение и подробно логируемые действия — не дублируются', async () => {
      const { log, i } = setup();
      await lastValueFrom(i.intercept(ctx('GET', '/api/calendar'), { handle: () => of('ok') } as CallHandler));
      await lastValueFrom(i.intercept(ctx('POST', '/api/bookings'), { handle: () => of('ok') } as CallHandler));
      expect(log.user).not.toHaveBeenCalled();
    });
  });

  it('выборка: период в поясе портала, объект, курсор', async () => {
    const findMany = vi.fn(async (_args: unknown) => Array.from({ length: 101 }, (_, k) => ({ id: `l${k}`, at: new Date(), actorKind: 'user', userId: 7, actorName: 'Анна', action: 'request', entityType: 'deal', entityId: '678', summary: 's', details: null, via: 'app' })));
    const prisma = { actionLog: { findMany, findFirst: vi.fn(async () => ({ id: 'l50', at: new Date('2026-10-22T10:00:00Z') })) } } as unknown as PrismaService;
    const r = await new ActionLogService(prisma).list('p1', 'Europe/Moscow', { from: '2026-10-22', to: '2026-10-22', entityType: 'deal', entityId: '678', before: 'l50' });
    expect(r.items).toHaveLength(100);
    expect(r.nextCursor).toBe('l99');
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { portalId: 'p1', entityType: 'deal', entityId: '678', at: { gte: new Date('2026-10-21T21:00:00Z'), lt: new Date('2026-10-22T21:00:00Z') } },
      take: 101,
    });
  });
});


describe('Пять записей журнала на страницу дашборда', () => {
  it.each(['p1', 'p2'])('5 → 5 → 1, неизменный период и tenant %s', async (portalId) => {
    const rows = Array.from({ length: 11 }, (_, k) => ({ id: `a${k}`, at: new Date(Date.parse('2026-10-24T10:00:00Z') - k * 60000), actorKind: 'user', userId: 7, actorName: 'Анна', action: 'request', entityType: null, entityId: null, summary: `Событие ${k}`, details: null, via: 'app' }));
    const findMany = vi.fn().mockResolvedValueOnce(rows.slice(0, 6)).mockResolvedValueOnce(rows.slice(5, 11)).mockResolvedValueOnce(rows.slice(10));
    const findFirst = vi.fn(async ({ where }: { where: { id: string; portalId: string } }) => where.portalId === portalId ? rows.find((r) => r.id === where.id) : null);
    const service = new ActionLogService({ actionLog: { findMany, findFirst } } as unknown as PrismaService);
    const q = { from: '2026-10-24', to: '2026-10-24', limit: '5' };
    const a = await service.list(portalId, 'Europe/Moscow', q);
    const b = await service.list(portalId, 'Europe/Moscow', { ...q, before: a.nextCursor });
    const c = await service.list(portalId, 'Europe/Moscow', { ...q, before: b.nextCursor });
    expect([a.items.length, b.items.length, c.items.length]).toEqual([5, 5, 1]);
    expect(new Set([...a.items, ...b.items, ...c.items].map((r) => r.id)).size).toBe(11);
    expect(c.nextCursor).toBeNull();
    for (const [args] of findMany.mock.calls) expect(args).toMatchObject({ take: 6, where: { portalId, at: { gte: new Date('2026-10-23T21:00:00Z'), lt: new Date('2026-10-24T21:00:00Z') } } });
    expect(findFirst).toHaveBeenCalledWith({ where: { portalId, id: 'a4' }, select: { at: true, id: true } });
  });
  it.each([0, -1, 101, 2.5, 'bad'])('отвергает limit %s', async (limit) => {
    await expect(new ActionLogService({} as PrismaService).list('p1', 'Europe/Moscow', { limit })).rejects.toThrow('limit:');
  });
});


describe('категории и критичность исторического журнала', () => {
  it.each(['p1', 'p2'])('фильтр проходит больше одной страницы источника и сохраняет tenant %s', async (portalId) => {
    const row = (i: number, error = false) => ({ id: `e${i}`, at: new Date(Date.parse('2026-10-24T12:00:00Z') - i * 1000), actorKind: 'user', userId: 7, actorName: 'Анна', action: error ? 'bitrix.error' : 'app.enter', summary: 'old', details: null, entityType: null, entityId: null, via: null });
    const first = Array.from({ length: 200 }, (_, i) => row(i));
    const errors = Array.from({ length: 11 }, (_, i) => row(200 + i, true));
    const all = [...first, ...errors];
    const findMany = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(errors).mockResolvedValueOnce(errors.slice(5));
    const findFirst = vi.fn(async ({ where }: { where: { id: string; portalId: string } }) => where.portalId === portalId ? all.find((r) => r.id === where.id) : null);
    const svc = new ActionLogService({ actionLog: { findMany, findFirst } } as unknown as PrismaService);
    const q = { category: 'errors', severity: 'high', limit: 5, from: '2026-10-24', to: '2026-10-24' };
    const a = await svc.list(portalId, 'Europe/Moscow', q);
    const b = await svc.list(portalId, 'Europe/Moscow', { ...q, before: a.nextCursor });
    expect(a.items.map((r) => r.id)).toEqual(['e200','e201','e202','e203','e204']);
    expect(b.items.map((r) => r.id)).toEqual(['e205','e206','e207','e208','e209']);
    expect(a.nextCursor).toBe('e204'); expect(b.nextCursor).toBe('e209');
    expect(a.items.every((r) => r.category === 'errors' && r.severity === 'high')).toBe(true);
    expect(findMany.mock.calls[1][0]).toMatchObject({ where: { AND: [expect.objectContaining({ portalId }), { OR: [{ at: { lt: first[199].at } }, { at: first[199].at, id: { lt: 'e199' } }] }] } });
    expect(findMany.mock.calls[2][0]).toMatchObject({ where: { portalId } });
  });
  it.each([{category:'unknown'}, {severity:'urgent'}])('отклоняет неподдержанный фильтр %j', async (q) => {
    await expect(new ActionLogService({} as PrismaService).list('p1','Europe/Moscow',q)).rejects.toThrow();
  });
});
