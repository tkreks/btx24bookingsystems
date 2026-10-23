import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AccessService } from '../access/access.service.js';
import type { ActionLogService } from '../audit/action-log.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { CertificatesService } from './certificates.service.js';

type Row = Record<string, unknown> & { id: string; portalId: string; number: string; status: string };

const user = (portalId = 'p1') => ({ portal: { id: portalId, timezone: 'Europe/Moscow' }, userId: 7, userName: 'Анна' }) as unknown as B24UserContext;

function setup({ manage = true, rows = [] as Row[] } = {}) {
  const certs: Row[] = [...rows];
  const events: Record<string, unknown>[] = [];
  const match = (r: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => r[k] === v);
  const certificate = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (certs.some((c) => c.portalId === data.portalId && c.number === data.number))
        throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
      const c = { id: `c${certs.length + 1}`, status: 'new', createdAt: new Date(), redeemedAt: null, ...data } as unknown as Row;
      certs.push(c);
      return c;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => certs.find((c) => match(c, where)) ?? null),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = certs.filter((c) => match(c, where));
      hit.forEach((c) => Object.assign(c, data));
      return { count: hit.length };
    }),
  };
  const certificateEvent = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => events.push({ id: `e${events.length}`, at: new Date(), ...data })),
    findMany: vi.fn(async () => []),
  };
  const prisma = {
    certificate,
    certificateEvent,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ certificate, certificateEvent })),
    $queryRaw: vi.fn(async () => [{ n: certs.filter((c) => /^\d+$/.test(c.number)).reduce((m, c) => Math.max(m, Number(c.number)), 0) || null }]),
  } as unknown as PrismaService;
  const access = { resolve: vi.fn(async () => ({ isAppAdmin: false, groups: manage ? [{ permissions: ['payment.send'] }] : [{ permissions: ['calendar.view'] }] })) } as unknown as AccessService;
  const log = { user: vi.fn(async () => undefined) } as unknown as ActionLogService;
  return { svc: new CertificatesService(prisma, access, log), certs, events, log };
}

const issue = { nominal: 5000, holderName: 'Иван Петров', paidOn: '2026-10-23', validUntil: '2027-04-23' };

describe('CertificatesService', () => {
  it('выпуск: следующий свободный номер, событие «выпуск», запись в журнал', async () => {
    const t = setup({ rows: [{ id: 'x', portalId: 'p1', number: '000041', status: 'new' }] });
    const r = await t.svc.issue(user(), issue);
    expect(r).toMatchObject({ number: '000042', nominal: 5000, holderName: 'Иван Петров', status: 'new', validUntil: '2027-04-23', paidOn: '2026-10-23' });
    expect(t.events).toMatchObject([{ action: 'issued', userId: 7 }]);
    expect(t.log.user).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'certificate.issued' }));
  });

  it('выпуск: занятый номер бланка → 409; срок раньше оплаты → 400; без права → 403', async () => {
    const t = setup({ rows: [{ id: 'x', portalId: 'p1', number: 'A-1', status: 'new' }] });
    await expect(t.svc.issue(user(), { ...issue, number: 'a-1' })).rejects.toBeInstanceOf(ConflictException);
    await expect(t.svc.issue(user(), { ...issue, validUntil: '2026-01-01' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(t.svc.issue(user(), { ...issue, nominal: 0 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(setup({ manage: false }).svc.issue(user(), issue)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('изменение срока — только у нового; погашение — один раз, причина = статус', async () => {
    const t = setup();
    const c = await t.svc.issue(user(), issue);
    const changed = await t.svc.change(user(), c.id, { validUntil: '2027-06-01' });
    expect(changed.validUntil).toBe('2027-06-01');
    expect(t.events.at(-1)).toMatchObject({ action: 'changed', details: { validUntil: { before: '2027-04-23', after: '2027-06-01' } } });
    const used = await t.svc.redeem(user(), c.id, { reason: 'used' });
    expect(used.status).toBe('used');
    await expect(t.svc.redeem(user(), c.id, { reason: 'expired' })).rejects.toBeInstanceOf(ConflictException);
    await expect(t.svc.change(user(), c.id, { validUntil: '2027-07-01' })).rejects.toBeInstanceOf(ConflictException);
    await expect(t.svc.redeem(user(), c.id, { reason: 'lost' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('сертификат другого портала — как несуществующий', async () => {
    const t = setup({ rows: [{ id: 'c9', portalId: 'p2', number: '1', status: 'new' }] });
    await expect(t.svc.get(user('p1'), 'c9')).rejects.toBeInstanceOf(NotFoundException);
    await expect(t.svc.redeem(user('p1'), 'c9', { reason: 'used' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
