import { useState } from 'react';
import { evalFormula, formulaRefs, type DealFormField } from '@btx24/shared';

/** Строки формы: поле с «2 в линии» и следующее за ним — одна строка из двух ячеек (как в настройках). */
export function fieldRows(fields: DealFormField[]): DealFormField[][] {
  const rows: DealFormField[][] = [];
  for (let i = 0; i < fields.length; i++)
    if (fields[i].inlineNext && fields[i + 1]) rows.push([fields[i], fields[++i]]);
    else rows.push([fields[i]]);
  return rows;
}

const fmt = (n: number) => String(n);

/** Пересчитать поля с формулой, которые ещё «автоматические» (несколько проходов — цепочки формул). */
function recalc(fields: DealFormField[], values: Record<string, string>, auto: Set<string>): Record<string, string> {
  const next = { ...values };
  for (let pass = 0; pass < 3; pass++)
    for (const f of fields)
      if (f.formula && auto.has(f.code)) {
        const v = evalFormula(f.formula, next);
        if (v !== null) next[f.code] = fmt(v);
      }
  return next;
}

/**
 * Значения полей сделки в форме. Создание брони: пустое в сделке поле получает значение по
 * умолчанию из настроек группы; поле с формулой считается само, пока его не поменяли руками.
 * Правка: значения сделки как есть, формула досчитывает только пустые поля.
 */
export function useDealFieldValues(fields: DealFormField[], mode: 'create' | 'edit', key: string) {
  const init = () => {
    const auto = new Set(fields.filter((f) => f.formula && !f.readOnly && !f.value).map((f) => f.code));
    const values: Record<string, string> = {};
    for (const f of fields) if (!f.readOnly) values[f.code] = f.value || (mode === 'create' && !f.formula ? (f.defaultValue ?? '') : '');
    return { key, values: recalc(fields, values, auto), auto };
  };
  const [state, setState] = useState(init);
  // Другие поля (сменили сделку или группу) — начинаем заново.
  let current = state;
  if (state.key !== key) {
    current = init();
    setState(current);
  }
  const set = (code: string, value: string) =>
    setState((s) => {
      const auto = new Set(s.auto);
      auto.delete(code);
      return { ...s, auto, values: recalc(fields, { ...s.values, [code]: value }, auto) };
    });
  /** Вернуть полю расчёт по формуле. */
  const resetFormula = (code: string) =>
    setState((s) => {
      const auto = new Set(s.auto).add(code);
      return { ...s, auto, values: recalc(fields, s.values, auto) };
    });
  return { values: current.values, auto: current.auto, set, resetFormula };
}

/** Формула словами для подсказки: `{OPPORTUNITY} * 50%` → «Сумма × 50%». */
function formulaText(formula: string, fields: DealFormField[]): string {
  return formula.replace(/\{([A-Z0-9_]+)\}/gi, (_, c: string) => fields.find((f) => f.code === c.toUpperCase())?.label ?? c).replace(/\*/g, '×').replace(/\//g, '÷');
}

/**
 * Поля сделки группы (⚙ → группа → «Поля сделки»): порядок и «2 в линии» из настроек, ввод по типу
 * поля, обязательность, формулы. Поля только для чтения показываются значением.
 */
export function DealFieldsEditor({
  fields,
  values,
  auto,
  onChange,
  onResetFormula,
}: {
  fields: DealFormField[];
  values: Record<string, string>;
  auto?: Set<string>;
  onChange: (code: string, value: string) => void;
  onResetFormula?: (code: string) => void;
}) {
  return (
    <div className="df-grid">
      {fieldRows(fields).map((row) => (
        <div key={row[0].code} className={`df-row${row.length > 1 ? ' pair' : ''}`}>
          {row.map((f) => {
            const manual = !!f.formula && !auto?.has(f.code);
            return (
              <label key={f.code} className="df-field">
                <span className="df-label">
                  {f.label}
                  {f.required && !f.readOnly && <i className="df-req" aria-label="обязательно">*</i>}
                  {f.formula && (
                    <span className="df-formula" title={`Формула: ${formulaText(f.formula, fields)}`}>
                      ƒ {formulaText(f.formula, fields)}
                    </span>
                  )}
                </span>
                {f.readOnly ? (
                  <span className="df-ro">{f.display || '—'}</span>
                ) : (
                  <span className="df-control">
                    <FieldInput field={f} value={values[f.code] ?? ''} onChange={(v) => onChange(f.code, v)} />
                    {f.kind === 'money' && <span className="df-suffix">₽</span>}
                    {manual && onResetFormula && formulaRefs(f.formula!).length > 0 && (
                      <button type="button" className="df-reset" title="Посчитать по формуле" onClick={(e) => (e.preventDefault(), onResetFormula(f.code))}>
                        ↺
                      </button>
                    )}
                  </span>
                )}
              </label>
            );
          })}
        </div>
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
      return <input inputMode="decimal" value={value} required={f.required} onChange={(e) => onChange(e.target.value)} />;
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

/** Значения формы из полей (как пришли с сервера) — для сравнения «что изменили». */
export const initialValues = (fields: DealFormField[]): Record<string, string> =>
  Object.fromEntries(fields.filter((f) => !f.readOnly).map((f) => [f.code, f.value]));
