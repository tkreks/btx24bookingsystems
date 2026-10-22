import type { Portal } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Bitrix24RestClient } from '../bitrix24/rest/rest-client.js';
import { BookingTypeFillService } from './booking-type-fill.service.js';
import type { DealFieldMapService } from './deal-field-map.service.js';

describe('BookingTypeFillService', () => {
  it('fills only an empty «Тип бронирования» by the deal products (как БП 270)', async () => {
    const rules = [
      { id: 'p', title: 'Программы', keywords: ['Алатырь'], dealTypeValue: '86', program: '@keyword', confirmation: [] },
      { id: 'h', title: 'Почасовая', keywords: ['Почасовая'], dealTypeValue: '9829f9e5', program: '', confirmation: [] },
      { id: 'x', title: 'Сломанный', keywords: ['Веник'], dealTypeValue: 'нет-такого', program: '', confirmation: [] },
    ];
    const prisma = {
      workGroup: { findMany: vi.fn(async () => [{ dealCategoryId: 0, options: { bookingTypes: rules } }, { dealCategoryId: 14, options: {} }]) },
    } as unknown as PrismaService;
    // Код варианта из БП (XML_ID) → номер варианта; неизвестный — null (не пишем).
    const fieldMap = { get: vi.fn(async () => ({ bookingType: 'UF_TYPE' })), enumId: vi.fn(async (_p: string, _c: unknown, _f: string, v: string) => (v === '9829f9e5' ? '88' : null)) } as unknown as DealFieldMapService;
    const listAll = vi.fn(async (_m: string, _p: unknown) => [
      { ID: '1', CATEGORY_ID: '0', UF_TYPE: null }, // пусто, товары — почасовая → заполнить
      { ID: '2', CATEGORY_ID: '0', UF_TYPE: '86' }, // менеджер выбрал — не трогать
      { ID: '3', CATEGORY_ID: '0', UF_TYPE: '' }, // пусто, товаров нет
      { ID: '4', CATEGORY_ID: '0', UF_TYPE: false }, // пусто, тип с неверным значением — пропуск
    ]);
    const batch = vi.fn(async () => ({
      result: { p1: [{ PRODUCT_NAME: 'Почасовая аренда бани' }], p3: [], p4: [{ PRODUCT_NAME: 'Веник' }] },
      errors: {},
    }));
    const call = vi.fn(async () => ({ result: true }));
    const client = { listAll, batch, call } as unknown as Bitrix24RestClient;
    const n = await new BookingTypeFillService(prisma, fieldMap).fill({ id: 'p1' } as Portal, client, new Date('2026-10-22T00:00:00Z'));
    expect(n).toBe(1);
    expect(listAll.mock.calls[0][1]).toMatchObject({ filter: { '@CATEGORY_ID': [0], STAGE_SEMANTIC_ID: 'P', '>=DATE_MODIFY': '2026-10-22T00:00:00.000Z' } });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('crm.deal.update', { id: 1, fields: { UF_TYPE: '88' } });
  });
});
