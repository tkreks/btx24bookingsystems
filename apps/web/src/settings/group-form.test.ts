import { describe, expect, it } from 'vitest';
import type { GroupDto } from '@btx24/shared';
import { defaultOptions, groupSettings, move, newDealField, newGroup, setResourceDefaults } from './group-form.js';

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

describe('group options helpers', () => {
  it('moves deal fields within bounds', () => {
    expect(move(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(move(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(move(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
  it('drops empty default product rows and the resource key when nothing is left', () => {
    const d = setResourceDefaults({ '1': [{ productId: 5, quantity: 1 }] }, 2, [
      { productId: 7, quantity: 2 },
      { productId: 0, quantity: 1 },
    ]);
    expect(d).toEqual({ '1': [{ productId: 5, quantity: 1 }], '2': [{ productId: 7, quantity: 2 }] });
    expect(setResourceDefaults(d, 1, [])).toEqual({ '2': [{ productId: 7, quantity: 2 }] });
  });
  it('new fields are visible on create and view, not in the list', () => {
    expect(newDealField('UF_X')).toMatchObject({ showCreate: true, showView: true, showList: false, required: false });
    expect(defaultOptions().payments.timeoutMinutes).toBe(60);
  });
});
