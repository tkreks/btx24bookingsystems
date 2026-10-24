import { callEntityRefs, crmEventTarget, dealColumns, dealSelect, entityColumns } from './crm-rows.js';

describe('Строки копии CRM', () => {
  it('поля сделки: базовые + коды сопоставления по алфавиту, без мусора и повторов', () => {
    const s = dealSelect(['UF_CRM_B', undefined, 'UF_CRM_A', 'UF_CRM_A', 'bad code', 'TITLE']);
    expect(s.slice(-2)).toEqual(['UF_CRM_A', 'UF_CRM_B']);
    expect(s.filter((x) => x === 'TITLE')).toHaveLength(1);
  });
  it('колонки сделки', () => {
    expect(dealColumns({ ID: '5', CATEGORY_ID: '0', CONTACT_ID: '0', ASSIGNED_BY_ID: '7', STAGE_SEMANTIC_ID: 'F', DATE_CREATE: '2026-10-01T10:00:00+03:00' })).toMatchObject({
      dealId: 5, categoryId: 0, contactId: null, assignedById: 7, stageSemantic: 'F', createdAt: new Date('2026-10-01T07:00:00Z'),
    });
  });
  it('события CRM', () => {
    expect(crmEventTarget('ONCRMDEALUPDATE', { FIELDS: { ID: '9' } })).toEqual({ kind: 'deal', typeId: 2, id: 9, deleted: false });
    expect(crmEventTarget('ONCRMCONTACTDELETE', { FIELDS: { ID: '3' } })).toEqual({ kind: 'entity', typeId: 3, id: 3, deleted: true });
    expect(crmEventTarget('ONCRMACTIVITYADD', { FIELDS: { ID: '1' } })).toMatchObject({ kind: 'call', id: 1 });
    expect(crmEventTarget('ONBOOKINGADD', { FIELDS: { ID: '1' } })).toBeNull();
    expect(crmEventTarget('ONCRMDEALADD', {})).toBeNull();
  });
  it('клиенты звонка и названия', () => {
    expect(callEntityRefs({ OWNER_TYPE_ID: '2', OWNER_ID: '5', COMMUNICATIONS: [{ ENTITY_TYPE_ID: '3', ENTITY_ID: '10' }] })).toEqual([{ typeId: 3, id: 10 }]);
    expect(entityColumns(3, { ID: '10', NAME: 'Иван', LAST_NAME: 'Петров', PHOTO: { showUrl: '/upload/a.jpg' } }, 'p.test')).toEqual({ entityId: 10, title: 'Иван Петров', photo: 'https://p.test/upload/a.jpg' });
    expect(entityColumns(4, { ID: '4' }, 'p.test').title).toBe('Компания #4');
  });
});
