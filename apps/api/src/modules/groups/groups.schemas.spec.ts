import { appSettingsSchema, groupOptionsSchema, groupSettingsSchema } from './groups.schemas.js';

const valid = {
  name: 'Бани',
  dealCategoryId: 14,
  resourceIds: [1, 2],
  bookingMode: 'duration',
  durationMinutes: 240,
  checkInTime: '14:00',
  checkOutTime: '12:00',
  defaultNights: 1,
  techWindowMinutes: 30,
  features: ['booking.details'],
  members: [{ kind: 'USER', bitrixId: 242, role: 'MANAGER' }],
};

describe('groupSettingsSchema', () => {
  it('accepts a complete group', () => {
    expect(groupSettingsSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['bad time', { checkInTime: '25:00' }],
    ['unknown feature', { features: ['delete.everything'] }],
    ['unknown role', { members: [{ kind: 'USER', bitrixId: 1, role: 'OWNER' }] }],
    ['tech window too long', { techWindowMinutes: 2000 }],
    ['empty name', { name: '  ' }],
    ['extra field', { portalId: 'other-portal' }],
  ])('rejects %s', (_label, patch) => {
    expect(groupSettingsSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe('appSettingsSchema', () => {
  it('requires metadata collection before texts can be collected', () => {
    expect(appSettingsSchema.safeParse({ dialogMetadataEnabled: false, dialogTextsEnabled: true, removeWazzupEmail: false, admins: [] }).success).toBe(false);
    expect(appSettingsSchema.safeParse({ dialogMetadataEnabled: true, dialogTextsEnabled: true, removeWazzupEmail: true, admins: [{ kind: 'DEPARTMENT', bitrixId: 3 }] }).success).toBe(true);
  });
});

describe('groupOptionsSchema — значения по умолчанию и формулы полей', () => {
  const f = (name: string, extra: object = {}) => ({ name, required: false, inlineNext: false, showCreate: true, showView: true, showList: false, ...extra });
  const opts = (dealFields: object[]) => ({ dealFields, productSectionIds: [], resourceDefaults: {}, views: { desktop: '', mobile: '' }, payments: undefined });
  const parse = (dealFields: object[]) => groupOptionsSchema.shape.dealFields.safeParse(opts(dealFields).dealFields);

  it('принимает формулу по полю группы и значение по умолчанию', () => {
    expect(parse([f('OPPORTUNITY'), f('UF_PRE', { formula: '{OPPORTUNITY} * 50%', defaultValue: '0' })]).success).toBe(true);
  });
  it('отклоняет формулу по чужому полю и с ошибкой', () => {
    const r = parse([f('OPPORTUNITY'), f('UF_PRE', { title: 'Предоплата', formula: '{UF_X} * 50%' })]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe('Формула поля «Предоплата»: Поля {UF_X} нет среди полей группы');
    expect(parse([f('OPPORTUNITY', { formula: '{OPPORTUNITY} * (2' })]).success).toBe(false);
  });
});

it('подтверждение принимает старые файлы Диска и копии вложений; отклоняет смешанные ссылки', () => {
  const option = (file: unknown) => ({ dealFields: [], productSectionIds: [], resourceDefaults: {}, views: { desktop: '', mobile: '' }, payments: { prepayment: { stageId: '', moveStage: false, templateId: '' }, surcharge: { stageId: '', moveStage: false, templateId: '' }, timeoutMinutes: 90, successStageId: '', failStageId: '', successTemplateId: '', failTemplateId: '' }, bookingTypes: [{ id: 'r', title: 'Программа', keywords: ['баня'], dealTypeValue: '', program: '', confirmation: [{ text: '', files: [file] }] }] });
  expect(groupOptionsSchema.safeParse(option({ id: 5, name: 'Правила.pdf' })).success).toBe(true);
  expect(groupOptionsSchema.safeParse(option({ storedFileId: 'saved', name: 'Правила.pdf' })).success).toBe(true);
  expect(groupOptionsSchema.safeParse(option({ id: 5, storedFileId: 'saved', name: 'bad' })).success).toBe(false);
});
