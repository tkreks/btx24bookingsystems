import { mapPrototype } from './prototype-mapper.js';
import { groupOptionsSchema } from '../groups/groups.schemas.js';

// Синтетический пример формата settings v8 (не реальные данные портала).
const sample = {
  version: 8,
  defaultGroupId: 'g_baths',
  removeWazzupEmail: true,
  groups: [
    {
      id: 'g_houses', title: 'Домики', kanbanCategoryId: '14', bookingMode: 'interval', checkInTime: '14:00', checkOutTime: '12:00', defaultDays: 1,
      durationHours: 1, techWindowMinutes: 0, resourceIds: [3, '4', 4, 'x'], productSectionIds: ['12', 'root'],
      resourceDefaults: { '3': [{ productId: 50, quantity: 1 }, { productId: 0 }], bad: [{ productId: 1 }] },
      dealFields: [{ name: 'UF_CRM_1', required: true, showList: true }, { name: 'bad field!' }],
      defaultDesktopView: 'availability', defaultMobileView: 'weird',
      prepaymentStageId: 'C14:PREPAY', prepaymentMoveStage: true, prepaymentTemplateId: '356', surchargeTemplateId: '356', paymentTimeoutMinutes: 60,
    },
    { id: 'g_baths', title: 'Бани', kanbanCategoryId: '0', bookingMode: 'duration', durationHours: 4, technicalWindowMinutes: 30, resourceIds: [1, 2] },
  ],
  externalUsers: [
    { login: 'viewer', password: 'abc123', role: 'viewer', groupIds: [], permissions: { allFields: true, fields: [] } },
    { login: 'tech', password: 'longenough', role: 'technologist', groupIds: ['g_baths', 'ghost'], permissions: { allFields: false, fields: ['UF_CRM_1', 'bad!'] } },
    { login: '', password: 'x' },
  ],
};

describe('mapPrototype', () => {
  const m = mapPrototype(sample);

  it('puts the default group first and maps time settings', () => {
    expect(m.groups.map((g) => g.name)).toEqual(['Бани', 'Домики']);
    expect(m.groups[0]).toMatchObject({ legacyId: 'g_baths', sort: 0, bookingMode: 'duration', durationMinutes: 240, techWindowMinutes: 30, dealCategoryId: 0, resourceIds: [1, 2] });
    expect(m.groups[1]).toMatchObject({ bookingMode: 'interval', checkInTime: '14:00', defaultNights: 1, dealCategoryId: 14, resourceIds: [3, 4] });
  });

  it('keeps options that have no columns yet and drops junk', () => {
    const o = m.groups[1].options;
    expect(o.resourceDefaults).toEqual({ '3': [{ productId: 50, quantity: 1 }] });
    expect(o.dealFields).toEqual([{ name: 'UF_CRM_1', required: true, inlineNext: false, showCreate: true, showView: true, showList: true }]);
    expect(o.views).toEqual({ desktop: 'availability', mobile: '' });
    expect(o.payments.prepayment).toEqual({ stageId: 'C14:PREPAY', moveStage: true, templateId: '356' });
    for (const g of m.groups) expect(groupOptionsSchema.safeParse(g.options).success).toBe(true);
  });

  it('maps external users: empty group list = all groups, field visibility, roles', () => {
    expect(m.externalUsers.map((u) => [u.login, u.role, u.allGroups, u.legacyGroupIds, u.visibleFields])).toEqual([
      ['viewer', 'VIEWER', true, [], null],
      ['tech', 'TECHNOLOGIST', false, ['g_baths'], ['UF_CRM_1']],
    ]);
  });

  it('reports problems instead of failing', () => {
    expect(m.warnings.join('\n')).toMatch(/без логина или пароля/);
    expect(m.warnings.join('\n')).toMatch(/несуществующие группы: ghost/);
    expect(m.warnings.join('\n')).toMatch(/короче 8 символов/);
    expect(m.removeWazzupEmail).toBe(true);
  });
});
