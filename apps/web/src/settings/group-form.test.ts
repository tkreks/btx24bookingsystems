import { describe, expect, it } from 'vitest';
import type { GroupDto } from '@btx24/shared';
import { groupSettings, newGroup } from './group-form.js';

describe('group editor payload', () => {
  it('retains imported payment and product settings when only membership changes', () => {
    const options = {
      dealFields: [
        { name: 'UF_CRM_TEST', required: true, inlineNext: false, showCreate: true, showView: true, showList: false },
      ],
      productSectionIds: ['12'],
      resourceDefaults: { '30': [{ productId: 7, quantity: 2 }] },
      views: { desktop: 'calendar', mobile: 'list' },
      payments: {
        prepayment: { stageId: 'PREPAY', moveStage: true, templateId: '2' },
        surcharge: { stageId: 'SURCHARGE', moveStage: false, templateId: '3' },
        timeoutMinutes: 30,
        successStageId: 'WON',
        failStageId: 'IN_PROGRESS',
        successTemplateId: '4',
        failTemplateId: '5',
      },
    } as const;
    const original = {
      ...newGroup(),
      id: 'g1',
      sort: 10,
      name: 'Бани',
      dealCategoryId: 0,
      resourceIds: [30],
      options: structuredClone(options),
    } as unknown as GroupDto;
    const payload = groupSettings(original);
    payload.members = [{ kind: 'USER', bitrixId: 242, role: 'MANAGER' }];
    expect(payload.options).toEqual(options);
    expect(payload).not.toHaveProperty('id');
    expect(payload).not.toHaveProperty('sort');
    expect(payload.dealCategoryId).toBe(0);
    expect(payload.resourceIds).toEqual([30]);
    payload.resourceIds.push(99);
    expect(original.resourceIds).toEqual([30]);
    expect(original.members).toEqual([]);
  });
});
