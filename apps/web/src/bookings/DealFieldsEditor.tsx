import type { DealFormField } from '@btx24/shared';

/**
 * Поля сделки группы (⚙ → группа → «Поля сделки»): ввод по типу поля, «два в строку»,
 * обязательность. Поля только для чтения показываются значением.
 */
export function DealFieldsEditor({
  fields,
  values,
  onChange,
}: {
  fields: DealFormField[];
  values: Record<string, string>;
  onChange: (code: string, value: string) => void;
}) {
  // «Два в строку»: поле с флагом и следующее за ним — половины одной строки.
  const half = new Set<string>();
  for (let i = 0; i < fields.length; i++)
    if (fields[i].inlineNext && fields[i + 1]) {
      half.add(fields[i].code);
      half.add(fields[++i].code);
    }
  return (
    <div className="deal-fields">
      {fields.map((f) => (
        <label key={f.code} className={half.has(f.code) ? 'half' : undefined}>
          <span>
            {f.label}
            {f.required && !f.readOnly ? ' *' : ''}
          </span>
          {f.readOnly ? (
            <span className="deal-field-ro">{f.display || '—'}</span>
          ) : (
            <FieldInput field={f} value={values[f.code] ?? ''} onChange={(v) => onChange(f.code, v)} />
          )}
        </label>
      ))}
    </div>
  );
}

function FieldInput({ field: f, value, onChange }: { field: DealFormField; value: string; onChange: (v: string) => void }) {
  switch (f.kind) {
    case 'enum':
      return (
        <select value={value} required={f.required} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(f.items ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.value}
            </option>
          ))}
        </select>
      );
    case 'boolean':
      return (
        <select value={value} required={f.required} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          <option value="Y">Да</option>
          <option value="N">Нет</option>
        </select>
      );
    case 'number':
    case 'money':
      return (
        <input
          inputMode="decimal"
          value={value}
          required={f.required}
          placeholder={f.kind === 'money' ? '₽' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
      return <input type="date" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime':
      return <input type="datetime-local" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />;
    default:
      return value.length > 60 || f.role === 'managerComment' || /comment/i.test(f.code) ? (
        <textarea rows={2} maxLength={5000} value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input value={value} maxLength={5000} required={f.required} onChange={(e) => onChange(e.target.value)} />
      );
  }
}

/** Значения формы из полей (как пришли с сервера). */
export const initialValues = (fields: DealFormField[]): Record<string, string> =>
  Object.fromEntries(fields.filter((f) => !f.readOnly).map((f) => [f.code, f.value]));
