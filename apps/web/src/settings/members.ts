import type { DepartmentItem, GroupMemberDto, GroupRole, MemberKind } from '@btx24/shared';

export const memberKey = (m: { kind: MemberKind; bitrixId: number }) => `${m.kind}:${m.bitrixId}`;

/** Добавляет новых участников с заданной ролью; уже добавленных не трогает (их роль не сбрасывается). */
export function addMembers(
  current: GroupMemberDto[],
  items: { kind: MemberKind; bitrixId: number }[],
  role: GroupRole,
): GroupMemberDto[] {
  const map = new Map(current.map((m) => [memberKey(m), m]));
  for (const m of items)
    if (!map.has(memberKey(m))) map.set(memberKey(m), { kind: m.kind, bitrixId: m.bitrixId, role });
  return [...map.values()];
}

/** Дети каждого отдела; корни — отделы без родителя или с родителем вне списка. */
export function departmentTree(departments: DepartmentItem[]): Map<number | null, DepartmentItem[]> {
  const ids = new Set(departments.map((d) => d.id));
  const tree = new Map<number | null, DepartmentItem[]>();
  for (const d of departments) {
    const parent = d.parentId !== null && ids.has(d.parentId) && d.parentId !== d.id ? d.parentId : null;
    tree.set(parent, [...(tree.get(parent) ?? []), d]);
  }
  for (const list of tree.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return tree;
}

/** Путь отдела для подсказки: «Компания › Продажи › Ресепшн». */
export function departmentPath(departments: DepartmentItem[], id: number): string {
  const byId = new Map(departments.map((d) => [d.id, d]));
  const names: string[] = [];
  const seen = new Set<number>();
  for (let d = byId.get(id); d && !seen.has(d.id); d = d.parentId === null ? undefined : byId.get(d.parentId)) {
    seen.add(d.id);
    names.unshift(d.name);
  }
  return names.join(' › ');
}

/** Отделы, в названии которых есть строка поиска (без учёта регистра). */
export function matchDepartments(departments: DepartmentItem[], query: string, limit = 8): DepartmentItem[] {
  const q = query.trim().toLocaleLowerCase('ru');
  if (q.length < 2) return [];
  return departments.filter((d) => d.name.toLocaleLowerCase('ru').includes(q)).slice(0, limit);
}
