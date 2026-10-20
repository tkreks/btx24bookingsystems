import { appSettingsSchema, groupSettingsSchema } from './groups.schemas.js';

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
