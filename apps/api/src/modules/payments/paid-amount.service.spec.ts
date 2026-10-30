import type { ActionLogService } from '../audit/action-log.service.js';
import type { DealFieldMapService } from '../bookings/deal-field-map.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { PaidAmountService } from './paid-amount.service.js';

function setup(o: { current?: string; map?: Record<string, string> } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const client = {
    // Как настоящий клиент: `crm.item.list` отдаёт `{ items }`, массив достаёт `pick`.
    listAll: vi.fn(async (_m: string, _p: unknown, opts: { pick?: (r: unknown) => unknown[] } = {}) => {
      const result = { items: [
        { id: 1, opportunity: 20000, stageId: 'DT31_2:N' }, // частично оплачен: 15000 из 20000
        { id: 2, opportunity: 5000, stageId: 'DT31_2:P' }, // отмечен «оплачен» вручную, оплат нет
        { id: 3, opportunity: 9000, stageId: 'DT31_2:D' }, // не оплачен
      ] };
      return opts.pick ? opts.pick(result) : Array.isArray(result) ? result : [];
    }),
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === 'crm.item.payment.list')
        return { result: params.entityId === 1 ? [{ paid: 'Y', sum: 10000 }, { paid: 'Y', sum: 5000 }, { paid: 'N', sum: 5000 }] : params.entityId === 3 ? [{ paid: 'N', sum: 9000 }] : [] };
      if (method === 'crm.deal.get') return { result: { UF_CRM_PAID: o.current ?? '' } };
      if (method === 'crm.deal.fields') return { result: { UF_CRM_PAID: { type: 'money', listLabel: 'Сумма внесённых оплат' } } };
      return { result: true };
    }),
  } as unknown as Bitrix24RestClient;
  const fieldMap = { get: vi.fn(async () => o.map ?? {}) } as unknown as DealFieldMapService;
  const actions = { log: vi.fn(async () => undefined) } as unknown as ActionLogService;
  return { svc: new PaidAmountService(fieldMap, actions), client, calls, actions };
}

describe('PaidAmountService — «Сумма внесённых оплат» заново по всем счетам сделки', () => {
  it('проведённые оплаты счетов + счёт, отмеченный оплаченным без оплат; не оплаченные — нет', async () => {
    const t = setup();
    expect(await t.svc.paidSum(t.client, 678)).toBe(20000);
    expect(t.client.listAll).toHaveBeenCalledWith('crm.item.list', expect.objectContaining({ entityTypeId: 31, filter: { parentId2: 678 } }), expect.objectContaining({ pick: expect.any(Function) }));
  });

  it('пишет в поле (найдено по названию) и в журнал, только если сумма изменилась', async () => {
    const t = setup({ current: '15000|RUB' });
    expect(await t.svc.recompute('p1', t.client, 678)).toBe(20000);
    expect(t.calls.find(([m]) => m === 'crm.deal.update')?.[1]).toEqual({ id: 678, fields: { UF_CRM_PAID: '20000|RUB' } });
    expect(t.actions.log).toHaveBeenCalled();
    const same = setup({ current: '20000|RUB', map: { paidAmount: 'UF_CRM_PAID' } });
    await same.svc.recompute('p1', same.client, 678);
    expect(same.calls.some(([m]) => m === 'crm.deal.update')).toBe(false);
  });
});
