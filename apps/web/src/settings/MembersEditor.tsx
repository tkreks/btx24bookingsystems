import { useState } from 'react';
import {
  ROLE_LABELS,
  ROLES,
  type AdminMemberDto,
  type GroupMemberDto,
  type GroupRole,
  type NamedBitrixItem,
} from '@btx24/shared';
import { selectEmployees } from '../b24.js';

type Member = AdminMemberDto & { role?: GroupRole };
export function MembersEditor({
  members,
  departments,
  users = [],
  onChange,
  withRoles = false,
}: {
  members: Member[];
  departments: NamedBitrixItem[];
  users?: NamedBitrixItem[];
  onChange: (members: GroupMemberDto[]) => void;
  withRoles?: boolean;
}) {
  const [names, setNames] = useState<Record<number, string>>({});
  const [department, setDepartment] = useState('');
  const [error, setError] = useState('');
  const normalized = members.map((m) => ({ ...m, role: m.role ?? ('VIEWER' as GroupRole) }));
  const add = (items: Member[]) => {
    const map = new Map(normalized.map((m) => [`${m.kind}:${m.bitrixId}`, m]));
    for (const m of items)
      if (!map.has(`${m.kind}:${m.bitrixId}`)) map.set(`${m.kind}:${m.bitrixId}`, { ...m, role: 'VIEWER' });
    onChange([...map.values()]);
  };
  const choose = () => {
    setError('');
    try {
      selectEmployees((users) => {
        setNames((prev) => ({ ...prev, ...Object.fromEntries(users.map((u) => [u.id, u.name])) }));
        add(users.map((u) => ({ kind: 'USER', bitrixId: u.id })));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось открыть выбор сотрудников');
    }
  };
  return (
    <div className="members-editor">
      <div className="form-actions">
        <button type="button" onClick={choose}>
          Добавить сотрудников
        </button>
        {departments.length > 0 && (
          <>
            <select aria-label="Отдел" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">Выберите отдел</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!department}
              onClick={() => {
                add([{ kind: 'DEPARTMENT', bitrixId: Number(department) }]);
                setDepartment('');
              }}
            >
              Добавить отдел
            </button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {members.length === 0 && <p className="muted">Участников пока нет.</p>}
      <ul className="member-list">
        {normalized.map((m, index) => (
          <li key={`${m.kind}:${m.bitrixId}`}>
            <span>
              {m.kind === 'USER'
                ? (names[m.bitrixId] ?? users.find((u) => u.id === m.bitrixId)?.name ?? `Сотрудник #${m.bitrixId}`)
                : (departments.find((d) => d.id === m.bitrixId)?.name ?? `Отдел #${m.bitrixId}`)}
            </span>
            {withRoles && (
              <select
                aria-label={`Роль ${m.kind === 'USER' ? 'сотрудника' : 'отдела'} #${m.bitrixId}`}
                value={m.role}
                onChange={(e) =>
                  onChange(
                    normalized.map((item, i) => (i === index ? { ...item, role: e.target.value as GroupRole } : item)),
                  )
                }
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              aria-label={`Удалить ${m.kind === 'USER' ? 'сотрудника' : 'отдел'} #${m.bitrixId}`}
              onClick={() => onChange(normalized.filter((_, i) => i !== index))}
            >
              Убрать
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
