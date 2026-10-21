import { describe, expect, it } from 'vitest';
import { addMembers, departmentPath, departmentTree, matchDepartments } from './members.js';

const departments = [
  { id: 1, name: 'Компания', parentId: null },
  { id: 5, name: 'Ресепшн', parentId: 1 },
  { id: 3, name: 'Бани', parentId: 1 },
  { id: 9, name: 'Сироты', parentId: 404 },
];

describe('member picker helpers', () => {
  it('adds new members with the chosen role and keeps existing roles', () => {
    const current = [{ kind: 'USER' as const, bitrixId: 7, role: 'MANAGER' as const }];
    expect(
      addMembers(
        current,
        [
          { kind: 'USER', bitrixId: 7 },
          { kind: 'DEPARTMENT', bitrixId: 7 },
        ],
        'VIEWER',
      ),
    ).toEqual([
      { kind: 'USER', bitrixId: 7, role: 'MANAGER' },
      { kind: 'DEPARTMENT', bitrixId: 7, role: 'VIEWER' },
    ]);
  });

  it('builds a sorted tree and treats unknown parents as roots', () => {
    const tree = departmentTree(departments);
    expect(tree.get(null)?.map((d) => d.id)).toEqual([1, 9]);
    expect(tree.get(1)?.map((d) => d.name)).toEqual(['Бани', 'Ресепшн']);
  });

  it('shows the department path and matches names case-insensitively', () => {
    expect(departmentPath(departments, 5)).toBe('Компания › Ресепшн');
    expect(matchDepartments(departments, 'реС').map((d) => d.id)).toEqual([5]);
    expect(matchDepartments(departments, 'р')).toEqual([]);
  });
});
