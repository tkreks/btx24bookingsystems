import type { AccessService } from '../access/access.service.js';
import type { B24UserContext } from '../bitrix24/auth/user-context.js';
import { BookingDirectoryService, sectionsWithChildren } from './booking-directory.service.js';

function setup(o: { can?: boolean; contacts?: unknown[]; deals?: unknown[]; dup?: number[] } = {}) {
  const group = { group: { id: 'g1', options: { productSectionIds: ['10'], resourceDefaults: { '30': [{ productId: 2, quantity: 1 }] } } }, permissions: ['booking.create'] };
  const access = { resolve: vi.fn(async () => ({})), pick: vi.fn(() => (o.can === false ? null : group)) } as unknown as AccessService;
  const listAll = vi.fn(async (method: string, params: { filter?: Record<string, unknown> }) => {
    if (method === 'crm.productsection.list') return [{ ID: '10', NAME: 'Бани' }, { ID: '11', NAME: 'Веники', SECTION_ID: '10' }, { ID: '20', NAME: 'Домики' }];
    if (method === 'crm.product.list')
      return [
        { ID: '1', NAME: 'Программа «Алатырь»', PRICE: '45000', CURRENCY_ID: 'RUB', SECTION_ID: '10' },
        { ID: '2', NAME: 'Веник дубовый', PRICE: '1500', CURRENCY_ID: 'RUB', SECTION_ID: '11' },
        { ID: '3', NAME: 'Домик', PRICE: '9000', CURRENCY_ID: 'RUB', SECTION_ID: '20' },
      ];
    if (method === 'crm.contact.list') {
      const f = params.filter ?? {};
      return (o.contacts ?? []).filter((c) => {
        const x = c as { ID: string; NAME?: string; LAST_NAME?: string };
        if (f.ID) return Number(x.ID) === f.ID;
        if (f['@ID']) return (f['@ID'] as number[]).includes(Number(x.ID));
        if (f['%LAST_NAME']) return (x.LAST_NAME ?? '').toLowerCase().includes(String(f['%LAST_NAME']));
        if (f['%NAME']) return (x.NAME ?? '').toLowerCase().includes(String(f['%NAME']));
        return true;
      });
    }
    if (method === 'crm.deal.list') return o.deals ?? [];
    if (method === 'user.get') return [{ ID: '7', NAME: 'Ольга', LAST_NAME: 'Петрова', PERSONAL_PHOTO: '/upload/o.jpg' }];
    return [];
  });
  const call = vi.fn(async () => ({ result: { CONTACT: o.dup ?? [] } }));
  const user = { portal: { id: 'p1', domain: 'x.bitrix24.ru' }, client: { listAll, call } } as unknown as B24UserContext;
  return { svc: new BookingDirectoryService(access), user, call, listAll };
}

describe('BookingDirectoryService', () => {
  it('разделы группы — вместе с вложенными', () => {
    expect([...sectionsWithChildren(['10'], [{ id: '10', parentId: null }, { id: '11', parentId: '10' }, { id: '12', parentId: '11' }, { id: '20', parentId: null }])]).toEqual(['10', '11', '12']);
  });

  it('товары группы — только из её разделов (с подразделами), товары по умолчанию', async () => {
    const t = setup();
    const c = await t.svc.catalog(t.user, 'g1');
    expect(c.products.map((p) => [p.id, p.section])).toEqual([[1, 'Бани'], [2, 'Веники']]);
    expect(c).toMatchObject({ restricted: true, defaults: { '30': [{ productId: 2, quantity: 1 }] } });
  });

  it('контакт: по телефону — через поиск дубликатов, по ФИО — все слова', async () => {
    const contacts = [
      { ID: '140', NAME: 'Анна', LAST_NAME: 'Иванова', PHONE: [{ VALUE: '+79991234567' }] },
      { ID: '150', NAME: 'Анна', LAST_NAME: 'Петрова' },
    ];
    const t = setup({ contacts, dup: [140] });
    const byPhone = await t.svc.search(t.user, { kind: 'contact', q: '8 999 123-45-67' });
    expect(t.call).toHaveBeenCalledWith('crm.duplicate.findbycomm', expect.objectContaining({ type: 'PHONE', values: ['+79991234567', '89991234567', '79991234567'] }));
    expect(byPhone.contacts.map((c) => [c.id, c.name, c.phones])).toEqual([[140, 'Анна Иванова', ['+79991234567']]]);
    const byName = await t.svc.search(t.user, { kind: 'contact', q: 'анна петр' });
    expect(byName.contacts.map((c) => c.id)).toEqual([150]);
    await expect(t.svc.search(t.user, { kind: 'contact', q: 'а' })).rejects.toMatchObject({ status: 400 });
  });

  it('сделки: открытые первыми, с клиентом; без права — 403', async () => {
    const deals = [
      { ID: '700', TITLE: 'Баня, октябрь', CLOSED: 'Y', CONTACT_ID: '140', CATEGORY_ID: '0' },
      { ID: '678', TITLE: 'Баня на субботу', CLOSED: 'N', CONTACT_ID: '140', CATEGORY_ID: '0', MODIFY_BY_ID: '7' },
    ];
    const t = setup({ deals, contacts: [{ ID: '140', NAME: 'Анна', LAST_NAME: 'Иванова', PHOTO: { showUrl: '/upload/a.jpg' } }] });
    const r = await t.svc.search(t.user, { contactId: '140' });
    expect(r.deals.map((d) => [d.id, d.closed, d.contact?.name])).toEqual([[678, false, 'Анна Иванова'], [700, true, 'Анна Иванова']]);
    // Выбранный клиент — с именем «Имя Фамилия» для шага мастера.
    expect(r.contacts.map((c) => [c.id, c.name, c.photo])).toEqual([[140, 'Анна Иванова', 'https://x.bitrix24.ru/upload/a.jpg']]);
    // Кто последним изменил сделку — имя и аватарка сотрудника.
    expect(r.deals.map((d) => d.modifiedBy)).toEqual([{ id: 7, name: 'Ольга Петрова', photo: 'https://x.bitrix24.ru/upload/o.jpg' }, null]);
    const no = setup({ can: false });
    await expect(no.svc.search(no.user, { kind: 'deal', q: 'баня' })).rejects.toMatchObject({ status: 403 });
  });

  it('номер сделки — она первой', async () => {
    const deals = [{ ID: '37678', TITLE: 'Заказ 678', CLOSED: 'N' }, { ID: '678', TITLE: 'Баня', CLOSED: 'Y' }];
    const t = setup({ deals });
    const r = await t.svc.search(t.user, { kind: 'deal', q: '678' });
    expect(r.deals.map((d) => d.id)).toEqual([678, 37678]);
  });
});
