import { useEffect, useState } from 'react';
import {
  ROLE_LABELS,
  ROLES,
  type AdminMemberDto,
  type DepartmentItem,
  type EmployeeDto,
  type GroupMemberDto,
  type GroupRole,
  type MemberKind,
  type NamedBitrixItem,
} from '@btx24/shared';
import { apiGet } from '../api.js';
import { selectEmployees } from '../b24.js';
import { addMembers, departmentPath, departmentTree, matchDepartments, memberKey } from './members.js';

type Member = AdminMemberDto & { role?: GroupRole };
type Person = { name: string; position?: string };

const ROLE_HINTS: Record<GroupRole, string> = {
  VIEWER: 'календарь и данные броней',
  TECHNOLOGIST: 'только занятость',
  MANAGER: 'брони и оплаты',
  GROUP_ADMIN: 'всё, включая настройки группы',
};

function RoleSelect({ value, label, onChange }: { value: GroupRole; label: string; onChange: (r: GroupRole) => void }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as GroupRole)}>
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}

export function MembersEditor({
  members,
  departments,
  users = [],
  onChange,
  withRoles = false,
}: {
  members: Member[];
  departments: DepartmentItem[];
  users?: NamedBitrixItem[];
  onChange: (members: GroupMemberDto[]) => void;
  withRoles?: boolean;
}) {
  const [people, setPeople] = useState<Record<number, Person>>({});
  const [newRole, setNewRole] = useState<GroupRole>('VIEWER');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; items: EmployeeDto[] } | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [error, setError] = useState('');
  const normalized: GroupMemberDto[] = members.map((m) => ({ ...m, role: m.role ?? 'VIEWER' }));
  const added = new Set(normalized.map(memberKey));

  const remember = (items: EmployeeDto[]) =>
    setPeople((prev) => ({
      ...prev,
      ...Object.fromEntries(items.map((u) => [u.id, { name: u.name, position: u.position }])),
    }));
  const add = (items: { kind: MemberKind; bitrixId: number }[]) => onChange(addMembers(normalized, items, newRole));

  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      apiGet<EmployeeDto[]>(`/admin/employees?q=${encodeURIComponent(q)}`).then(
        (items) => {
          if (!active) return;
          remember(items);
          setFound({ query: q, items });
        },
        (e) => active && setError(e instanceof Error ? e.message : 'Не удалось найти сотрудников'),
      );
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [q]);

  const chooseInBitrix = () => {
    setError('');
    try {
      selectEmployees((items) => {
        setPeople((prev) => ({ ...prev, ...Object.fromEntries(items.map((u) => [u.id, { name: u.name }])) }));
        add(items.map((u) => ({ kind: 'USER', bitrixId: u.id })));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось открыть выбор сотрудников');
    }
  };

  const personName = (id: number) => people[id]?.name ?? users.find((u) => u.id === id)?.name ?? `Сотрудник #${id}`;
  const deptName = (id: number) => departmentPath(departments, id) || `Отдел #${id}`;
  const deptMatches = matchDepartments(departments, q);
  const employeeMatches = found?.query === q ? found.items : null;

  const memberRow = (m: GroupMemberDto) => {
    const index = normalized.indexOf(m);
    const isUser = m.kind === 'USER';
    const title = isUser ? personName(m.bitrixId) : deptName(m.bitrixId);
    return (
      <li key={memberKey(m)}>
        <span>
          {title}
          {isUser && people[m.bitrixId]?.position && <small className="muted"> · {people[m.bitrixId].position}</small>}
        </span>
        {withRoles && (
          <RoleSelect
            label={`Роль: ${title}`}
            value={m.role}
            onChange={(role) => onChange(normalized.map((item, i) => (i === index ? { ...item, role } : item)))}
          />
        )}
        <button
          type="button"
          aria-label={`Убрать: ${title}`}
          onClick={() => onChange(normalized.filter((_, i) => i !== index))}
        >
          Убрать
        </button>
      </li>
    );
  };
  const userMembers = normalized.filter((m) => m.kind === 'USER');
  const deptMembers = normalized.filter((m) => m.kind === 'DEPARTMENT');

  return (
    <div className="members-editor">
      <div className="member-picker">
        <input
          type="search"
          placeholder={departments.length ? 'Сотрудник или отдел: имя, должность, название' : 'Имя или должность'}
          aria-label="Поиск сотрудников и отделов"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setError('');
          }}
        />
        {withRoles && (
          <label className="inline">
            <span className="muted">Добавлять с ролью</span>
            <RoleSelect label="Роль для добавляемых" value={newRole} onChange={setNewRole} />
          </label>
        )}
      </div>

      {q.length >= 2 && (
        <ul className="member-suggest">
          {deptMatches.map((d) => (
            <PickRow
              key={`d${d.id}`}
              title={departmentPath(departments, d.id)}
              note="отдел, со вложенными"
              added={added.has(`DEPARTMENT:${d.id}`)}
              onAdd={() => add([{ kind: 'DEPARTMENT', bitrixId: d.id }])}
            />
          ))}
          {employeeMatches === null && <li className="muted">Поиск сотрудников…</li>}
          {employeeMatches?.map((u) => (
            <PickRow
              key={`u${u.id}`}
              title={u.name}
              note={[u.position, ...u.departmentIds.map((id) => departments.find((d) => d.id === id)?.name)]
                .filter(Boolean)
                .join(' · ')}
              added={added.has(`USER:${u.id}`)}
              onAdd={() => add([{ kind: 'USER', bitrixId: u.id }])}
            />
          ))}
          {employeeMatches?.length === 0 && deptMatches.length === 0 && <li className="muted">Ничего не найдено</li>}
        </ul>
      )}

      <div className="form-actions">
        {departments.length > 0 && (
          <button type="button" onClick={() => setTreeOpen((v) => !v)} aria-expanded={treeOpen}>
            {treeOpen ? 'Скрыть структуру' : 'Структура компании'}
          </button>
        )}
        <button type="button" onClick={chooseInBitrix}>
          Выбрать в Битрикс24
        </button>
      </div>
      {treeOpen && (
        <DepartmentTree departments={departments} added={added} onAdd={add} onLoaded={remember} onError={setError} />
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {normalized.length === 0 && <p className="muted">Участников пока нет.</p>}
      {userMembers.length > 0 && (
        <>
          <h4>Сотрудники</h4>
          <ul className="member-list">{userMembers.map(memberRow)}</ul>
        </>
      )}
      {deptMembers.length > 0 && (
        <>
          <h4>Отделы (со всеми вложенными)</h4>
          <ul className="member-list">{deptMembers.map(memberRow)}</ul>
        </>
      )}
      {withRoles && (
        <p className="muted">
          {ROLES.map((r) => `${ROLE_LABELS[r]} — ${ROLE_HINTS[r]}`).join('; ')}. Роль, назначенная сотруднику лично,
          важнее роли его отдела.
        </p>
      )}
    </div>
  );
}

function PickRow({ title, note, added, onAdd }: { title: string; note?: string; added: boolean; onAdd: () => void }) {
  return (
    <li>
      <span>
        {title}
        {note && <small className="muted"> · {note}</small>}
      </span>
      <button type="button" disabled={added} onClick={onAdd} aria-label={`Добавить: ${title}`}>
        {added ? 'Добавлен' : 'Добавить'}
      </button>
    </li>
  );
}

/** Дерево отделов: отдел можно добавить целиком или раскрыть и выбрать сотрудников поимённо. */
function DepartmentTree({
  departments,
  added,
  onAdd,
  onLoaded,
  onError,
}: {
  departments: DepartmentItem[];
  added: Set<string>;
  onAdd: (items: { kind: MemberKind; bitrixId: number }[]) => void;
  onLoaded: (items: EmployeeDto[]) => void;
  onError: (message: string) => void;
}) {
  const tree = departmentTree(departments);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [staff, setStaff] = useState<Record<number, EmployeeDto[] | 'loading'>>({});

  const toggle = (id: number) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (staff[id]) return;
    setStaff((prev) => ({ ...prev, [id]: 'loading' }));
    apiGet<EmployeeDto[]>(`/admin/employees?departmentId=${id}`).then(
      (items) => {
        onLoaded(items);
        setStaff((prev) => ({ ...prev, [id]: items }));
      },
      (e) => {
        setStaff((prev) => {
          const { [id]: _, ...rest } = prev;
          return rest;
        });
        onError(e instanceof Error ? e.message : 'Не удалось загрузить сотрудников отдела');
      },
    );
  };

  const node = (d: DepartmentItem) => {
    const isOpen = open.has(d.id);
    const list = staff[d.id];
    return (
      <li key={d.id}>
        <div className="tree-row">
          <button type="button" className="tree-toggle" aria-expanded={isOpen} onClick={() => toggle(d.id)}>
            {isOpen ? '▾' : '▸'} {d.name}
          </button>
          <button
            type="button"
            disabled={added.has(`DEPARTMENT:${d.id}`)}
            onClick={() => onAdd([{ kind: 'DEPARTMENT', bitrixId: d.id }])}
            aria-label={`Добавить отдел ${d.name}`}
          >
            {added.has(`DEPARTMENT:${d.id}`) ? 'Отдел добавлен' : '+ отдел'}
          </button>
        </div>
        {isOpen && (
          <ul>
            {list === 'loading' && <li className="muted">Загрузка…</li>}
            {Array.isArray(list) &&
              list.map((u) => (
                <PickRow
                  key={`u${u.id}`}
                  title={u.name}
                  note={u.position}
                  added={added.has(`USER:${u.id}`)}
                  onAdd={() => onAdd([{ kind: 'USER', bitrixId: u.id }])}
                />
              ))}
            {Array.isArray(list) && list.length === 0 && !tree.get(d.id) && <li className="muted">Сотрудников нет</li>}
            {tree.get(d.id)?.map(node)}
          </ul>
        )}
      </li>
    );
  };
  return <ul className="department-tree">{tree.get(null)?.map(node)}</ul>;
}
