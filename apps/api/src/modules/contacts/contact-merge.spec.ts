import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { RateLimiter } from '../bitrix24/rest/rate-limiter.js';
import { ActionLogService } from '../audit/action-log.service.js';
import { PermanentAdminGuard } from '../access/permanent-admin.guard.js';
import { ContactDuplicatesController } from './contact-duplicates.controller.js';
import { ContactDuplicatesService } from './contact-duplicates.service.js';
import { ContactMergeService } from './contact-merge.service.js';

const META = {
  ID: { type: 'integer', isReadOnly: true },
  NAME: { type: 'string', title: 'Имя' },
  POST: { type: 'string', title: 'Должность' },
  COMMENTS: { type: 'string', title: 'Комментарий' },
  SOURCE_ID: { type: 'crm_status', statusType: 'SOURCE', title: 'Источник' },
  PHONE: { type: 'crm_multifield', isMultiple: true, title: 'Телефон' },
};

type Row = Record<string, unknown>;

/** Портал на fetch: контакты, сделки, update/mergeBatch; mergeBatch — CONFLICT, если поля ещё различаются. */
function portal(rows: Record<number, Row>, deals: Record<number, number>, opts: { mergeStatus?: string } = {}) {
  const writes: { method: string; params: Row }[] = [];
  const single = ['NAME', 'POST', 'COMMENTS', 'SOURCE_ID'];
  const one = (method: string, params: Row): { result?: unknown; error?: string; total?: number } => {
    if (method === 'crm.contact.fields') return { result: META };
    if (method === 'crm.contact.get') return rows[Number(params.id)] ? { result: { ...rows[Number(params.id)] } } : { error: 'Not found' };
    if (method === 'crm.deal.list') return { result: [], total: deals[Number((params.filter as Row).CONTACT_ID)] ?? 0 };
    if (method === 'crm.status.list') return { result: [{ STATUS_ID: 'CALL', NAME: 'Звонок' }] };
    if (method === 'crm.contact.update') {
      writes.push({ method, params });
      Object.assign(rows[Number(params.id)]!, params.fields);
      return { result: true };
    }
    if (method === 'crm.entity.mergeBatch') {
      writes.push({ method, params });
      const ids = (params.params as { entityIds: number[] }).entityIds;
      const conflict = single.some((f) => new Set(ids.map((id) => String(rows[id]![f] ?? '').trim()).filter(Boolean)).size > 1);
      const status = opts.mergeStatus ?? (conflict ? 'CONFLICT' : 'SUCCESS');
      if (status === 'SUCCESS') for (const id of ids.slice(1)) delete rows[id];
      return { result: { STATUS: status, ENTITY_IDS: status === 'SUCCESS' ? ids.slice(1) : [] } };
    }
    return { error: 'METHOD_NOT_FOUND' };
  };
  const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    const method = url.split('/').pop()!.replace(/\.json$/, '');
    const body = JSON.parse(init.body) as Row;
    if (method !== 'batch') return new Response(JSON.stringify(one(method, body)), { status: 200 });
    const out: { result: Row; result_error: Row; result_total: Row } = { result: {}, result_error: {}, result_total: {} };
    for (const [key, cmd] of Object.entries(body.cmd as Record<string, string>)) {
      const [m, qs] = cmd.split('?') as [string, string | undefined];
      const q = new URLSearchParams(qs ?? '');
      const params: Row = { id: q.get('id'), filter: { CONTACT_ID: q.get('filter[CONTACT_ID]') } };
      const r = one(m, params);
      if (r.error) out.result_error[key] = { error: r.error };
      else out.result[key] = r.result;
      if (r.total !== undefined) out.result_total[key] = r.total;
    }
    return new Response(JSON.stringify({ result: out }), { status: 200 });
  });
  const client = new Bitrix24RestClient({
    clientEndpoint: 'https://portal.example/rest/',
    access: { getAccessToken: async () => 't', refresh: async () => 't' },
    limiter: new RateLimiter(1000, 1000),
    limiterKey: 'm1',
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, writes, rows };
}

function setup(p: ReturnType<typeof portal>) {
  const logs: { action: string; entityId: string | null; details: unknown; at: Date; portalId: string }[] = [];
  const prisma = {
    actionLog: {
      create: vi.fn(async ({ data }: { data: (typeof logs)[number] }) => logs.unshift({ ...data, at: new Date() })),
      findMany: vi.fn(async ({ where }: { where: { portalId: string; action: string; entityId: string } }) =>
        logs.filter((l) => l.portalId === where.portalId && l.action === where.action && l.entityId === where.entityId),
      ),
    },
    crmEntity: { updateMany: vi.fn(async () => ({ count: 1 })), findMany: vi.fn(async () => []) },
    portalEmployee: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
  };
  const duplicates = new ContactDuplicatesService(prisma as never);
  const invalidate = vi.spyOn(duplicates, 'invalidate');
  const service = new ContactMergeService(prisma as never, duplicates, new ActionLogService(prisma as never));
  const user = { portal: { id: 'p1' }, userId: 1, userName: 'Админ', client: p.client } as never;
  return { service, duplicates, prisma, logs, user, invalidate };
}

const rowsFixture = (): Record<number, Row> => ({
  10: { ID: '10', NAME: 'Виктория', POST: 'Менеджер', COMMENTS: '', SOURCE_ID: 'CALL', DATE_CREATE: '2025-12-15T16:11:02+03:00', PHONE: [{ VALUE: '+79120000001' }] },
  20: { ID: '20', NAME: 'Виктория', POST: 'Директор', COMMENTS: 'VIP', SOURCE_ID: '', DATE_CREATE: '2025-12-26T13:44:56+03:00', PHONE: [{ VALUE: '89120000001' }] },
  30: { ID: '30', NAME: 'Вика', POST: '', COMMENTS: 'старый', SOURCE_ID: '', DATE_CREATE: '2024-01-01T00:00:00+03:00' },
});

describe('сравнение (Битрикс24)', () => {
  it('свежие данные, подписи статусов, число сделок, основной по сделкам', async () => {
    const t = setup(portal(rowsFixture(), { 10: 1, 20: 3, 30: 0 }));
    const dto = await t.duplicates.compare(t.user, [10, 20, 30]);
    expect(dto.suggestedPrimaryId).toBe(20);
    expect(dto.contacts.map((c) => c.dealsCount)).toEqual([1, 3, 0]);
    const by = Object.fromEntries(dto.fields.map((f) => [f.code, f]));
    expect(by.SOURCE_ID).toMatchObject({ conflict: false, values: { '10': 'Звонок', '20': null } });
    expect(by.POST!.conflict).toBe(true);
    expect(by.PHONE).toMatchObject({ kind: 'multi', conflict: false });
    expect(by).not.toHaveProperty('ID');
  });
});

describe('объединение', () => {
  it('записывает выбранные значения в основной и в контакты с иным значением, затем mergeBatch [основной, …]', async () => {
    const p = portal(rowsFixture(), {});
    const t = setup(p);
    const r = await t.service.merge(t.user, { idempotencyKey: 'key-00001', primaryId: 20, ids: [10, 20, 30], choices: { NAME: 30, POST: 10 } });
    expect(r).toEqual({ status: 'merged', primaryId: 20, removedIds: [10, 30], conflicts: [], warnings: [] });
    const updates = p.writes.filter((w) => w.method === 'crm.contact.update');
    // NAME: «Вика» (выбрано у 30) → в 20 и 10. POST: «Менеджер» (у 10) → в 20 (у 30 пусто — не трогаем).
    // COMMENTS: по умолчанию у основного «VIP» → в 30 (у 10 пусто).
    expect(updates.map((u) => [u.params.id, u.params.fields])).toEqual([
      [20, { NAME: 'Вика', POST: 'Менеджер' }],
      [10, { NAME: 'Вика' }],
      [30, { COMMENTS: 'VIP' }],
    ]);
    expect(updates.every((u) => !('PHONE' in (u.params.fields as Row)))).toBe(true);
    const merge = p.writes.find((w) => w.method === 'crm.entity.mergeBatch')!;
    expect(merge.params.params).toEqual({ entityTypeId: 3, entityIds: [20, 10, 30] });
    expect(t.prisma.crmEntity.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ portalId: 'p1', entityTypeId: 3, entityId: { in: [10, 30] } }) }));
    expect(t.invalidate).toHaveBeenCalledWith('p1');
    expect(t.logs[0]).toMatchObject({ action: 'contact.merged', entityId: '20', details: expect.objectContaining({ idempotencyKey: 'key-00001', removedIds: [10, 30] }) });
    expect((t.logs[0] as unknown as { summary: string }).summary).toBe('Объединены контакты #20, #10, #30 → #20');
  });

  it('пустое выбранное значение очищает поле у остальных', async () => {
    const p = portal(rowsFixture(), {});
    const t = setup(p);
    const r = await t.service.merge(t.user, { idempotencyKey: 'key-00002', primaryId: 10, ids: [10, 20, 30], choices: { POST: 30, COMMENTS: 10 } });
    expect(r.status).toBe('merged');
    const updates = p.writes.filter((w) => w.method === 'crm.contact.update').map((u) => [u.params.id, u.params.fields]);
    expect(updates).toEqual([
      [10, { POST: '' }],
      [20, { POST: '', COMMENTS: '' }],
      [30, { NAME: 'Виктория', COMMENTS: '' }],
    ]);
  });

  it('повтор с тем же ключом не объединяет повторно', async () => {
    const p = portal(rowsFixture(), {});
    const t = setup(p);
    const body = { idempotencyKey: 'key-00003', primaryId: 10, ids: [10, 20], choices: {} };
    const [a, b] = await Promise.all([t.service.merge(t.user, body), t.service.merge(t.user, body)]);
    expect(a).toBe(b);
    const again = await t.service.merge(t.user, body);
    expect(again).toMatchObject({ status: 'merged', removedIds: [20] });
    expect(again.warnings[0]).toContain('Повтор');
    expect(p.writes.filter((w) => w.method === 'crm.entity.mergeBatch')).toHaveLength(1);
  });

  it('CONFLICT от Битрикс24 → status conflict, поля перечитаны; ERROR → 502', async () => {
    const p = portal(rowsFixture(), {}, { mergeStatus: 'CONFLICT' });
    const t = setup(p);
    const r = await t.service.merge(t.user, { idempotencyKey: 'key-00004', primaryId: 10, ids: [10, 20], choices: {} });
    expect(r).toMatchObject({ status: 'conflict', removedIds: [], conflicts: [] });
    expect(r.warnings.join(' ')).toContain('не видит');
    expect(t.invalidate).not.toHaveBeenCalled();
    expect(t.logs[0]!.action).toBe('contact.merge_conflict');

    const e = setup(portal(rowsFixture(), {}, { mergeStatus: 'ERROR' }));
    await expect(e.service.merge(e.user, { idempotencyKey: 'key-00005', primaryId: 10, ids: [10, 20], choices: {} })).rejects.toMatchObject({ status: 502 });
  });

  it('валидация: основной в группе, без повторов, выбор только из группы', async () => {
    const t = setup(portal(rowsFixture(), {}));
    for (const body of [
      { idempotencyKey: 'key-00006', primaryId: 99, ids: [10, 20], choices: {} },
      { idempotencyKey: 'key-00006', primaryId: 10, ids: [10, 10], choices: {} },
      { idempotencyKey: 'key-00006', primaryId: 10, ids: [10, 20], choices: { NAME: 30 } },
      { idempotencyKey: 'key-00006', primaryId: 10, ids: [10], choices: {} },
    ])
      await expect(t.service.merge(t.user, body)).rejects.toMatchObject({ status: 400 });
  });

  it('контакты пишет только через разрешение объединения', async () => {
    const p = portal(rowsFixture(), {});
    const t = setup(p);
    await expect(t.service.merge(t.user, { idempotencyKey: 'key-00007', primaryId: 10, ids: [10, 20], choices: {} })).resolves.toMatchObject({ status: 'merged' });
    await expect(p.client.call('crm.contact.update', { id: 10, fields: { NAME: 'x' } })).rejects.toMatchObject({ code: 'CONTACT_WRITE_DISABLED' });
    await expect(p.client.call('crm.entity.mergeBatch', { params: { entityTypeId: 3, entityIds: [10, 20] } })).rejects.toMatchObject({ code: 'CONTACT_WRITE_DISABLED' });
  });
});

describe('доступ', () => {
  it('контроллер — только постоянные администраторы', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ContactDuplicatesController)).toContain(PermanentAdminGuard);
  });
  it('не администратор и временный администратор → 403', async () => {
    const ctx = (b24: unknown) => ({ switchToHttp: () => ({ getRequest: () => ({ b24 }) }) }) as never;
    const guard = (a: object) => new PermanentAdminGuard({ resolve: async () => a } as never);
    await expect(guard({ isAppAdmin: false }).canActivate(ctx({}))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard({ isAppAdmin: true, tempAdminUntil: new Date() }).canActivate(ctx({}))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard({ isAppAdmin: true, tempAdminUntil: null }).canActivate(ctx({}))).resolves.toBe(true);
  });
});
