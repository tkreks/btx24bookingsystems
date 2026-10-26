import { useState, type ReactNode } from 'react';
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

/** Список коротких вариантов (до 5, каждый до 16 символов) — сегментными чипами, иначе — select. */
export const chipsFor = (f: Pick<DealFormField, 'kind' | 'items'>) =>
  f.kind === 'enum' && !!f.items?.length && f.items.length <= 5 && f.items.every((i) => i.value.length <= 16);

/**
 * Поля сделки группы (⚙ → группа → «Поля сделки»): порядок и «2 в линии» из настроек, ввод по типу
 * поля, обязательность, формулы. Поля только для чтения показываются значением (`compactReadOnly` —
 * одной строкой «подпись: значение» внизу). `errors` — незаполненные обязательные, которые уже пора
 * подсветить; `override` — свой контрол для поля (сумма сделки «из товаров»).
 */
export function DealFieldsEditor({
  fields,
  values,
  auto,
  onChange,
  onResetFormula,
  errors,
  onBlurField,
  compactReadOnly = false,
  bookingDate,
  override,
}: {
  fields: DealFormField[];
  values: Record<string, string>;
  auto?: Set<string>;
  onChange: (code: string, value: string) => void;
  onResetFormula?: (code: string) => void;
  errors?: ReadonlySet<string>;
  onBlurField?: (code: string) => void;
  compactReadOnly?: boolean;
  /** Дата брони (YYYY-MM-DD) — быстрый выбор у полей-дат. */
  bookingDate?: string;
  override?: (f: DealFormField) => ReactNode | null;
}) {
  const editable = compactReadOnly ? fields.filter((f) => !f.readOnly) : fields;
  const readOnly = compactReadOnly ? fields.filter((f) => f.readOnly && (f.display || f.value)) : [];
  return (
    <div className="df-grid">
      {fieldRows(editable).map((row) => (
        <div key={row[0].code} className={`df-row${row.length > 1 ? ' pair' : ''}`}>
          {row.map((f) => {
            const manual = !!f.formula && !auto?.has(f.code);
            const invalid = !!errors?.has(f.code);
            const value = values[f.code] ?? '';
            const own = override?.(f) ?? null;
            const byDefault = !!f.defaultValue && !f.value && value === f.defaultValue && !f.formula;
            const wide = f.kind === 'string' && isLongText(f, value);
            return (
              <div
                key={f.code}
                className={`df-field${invalid ? ' invalid' : ''}${wide && row.length > 1 ? ' wide' : ''}`}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onBlurField?.(f.code);
                }}
              >
                <span className="df-label" id={`df-${f.code}`}>
                  {f.label}
                  {f.required && !f.readOnly && <i className="df-req" aria-label="обязательно">*</i>}
                  {f.formula && (
                    <span className="df-formula" title={`Формула: ${formulaText(f.formula, fields)}`}>
                      ƒ {manual ? 'вручную' : 'авто'}
                    </span>
                  )}
                  {byDefault && <span className="df-default">по умолчанию</span>}
                </span>
                {own ?? (f.readOnly ? (
                  <span className="df-ro">{f.display || '—'}</span>
                ) : (
                  <span className="df-control">
                    <FieldInput field={f} value={value} invalid={invalid} onChange={(v) => onChange(f.code, v)} />
                    {f.kind === 'money' && <span className="df-suffix">₽</span>}
                    {manual && onResetFormula && formulaRefs(f.formula!).length > 0 && (
                      <button type="button" className="df-reset" title="Посчитать по формуле" onClick={(e) => (e.preventDefault(), onResetFormula(f.code))}>
                        ↺
                      </button>
                    )}
                  </span>
                ))}
                {f.formula && !own && !f.readOnly && <span className="df-hint">= {formulaText(f.formula, fields)}</span>}
                {(f.kind === 'date' || f.kind === 'datetime') && !f.readOnly && !own && (
                  <span className="df-quick">
                    <button type="button" className="link" onClick={() => onChange(f.code, dateValue(f.kind, todayLocal()))}>
                      сегодня
                    </button>
                    {bookingDate && (
                      <>
                        {' · '}
                        <button type="button" className="link" onClick={() => onChange(f.code, dateValue(f.kind, bookingDate))}>
                          дата брони
                        </button>
                      </>
                    )}
                  </span>
                )}
                {invalid && (
                  <span className="df-error" role="alert">
                    ⚠ Обязательное поле
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {readOnly.length > 0 && (
        <p className="df-ro-list">
          {readOnly.map((f) => (
            <span key={f.code}>
              {f.label}: <b>{f.display || f.value}</b>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

const isLongText = (f: DealFormField, value: string) => value.length > 60 || f.role === 'managerComment' || /comment/i.test(f.code);
const todayLocal = () => new Intl.DateTimeFormat('sv-SE').format(new Date());
const dateValue = (kind: DealFormField['kind'], date: string) => (kind === 'datetime' ? `${date}T12:00` : date);

function FieldInput({ field: f, value, invalid, onChange }: { field: DealFormField; value: string; invalid: boolean; onChange: (v: string) => void }) {
  const a11y = { 'aria-labelledby': `df-${f.code}`, 'aria-required': f.required || undefined, 'aria-invalid': invalid || undefined };
  if (chipsFor(f))
    return (
      <span className="df-chips" role="radiogroup" {...a11y}>
        {(f.items ?? []).map((i) => (
          <button key={i.id} type="button" role="radio" aria-checked={value === i.id} className={value === i.id ? 'active' : ''} onClick={() => onChange(value === i.id && !f.required ? '' : i.id)}>
            {i.value}
          </button>
        ))}
      </span>
    );
  switch (f.kind) {
    case 'enum':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} {...a11y}>
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
        <span className="segmented df-yesno" role="radiogroup" {...a11y}>
          {(
            [
              ['Y', 'Да'],
              ['N', 'Нет'],
              ['', '—'],
            ] as const
          ).map(([v, label]) => (
            <button key={v || 'none'} type="button" role="radio" aria-checked={value === v} className={value === v ? 'active' : ''} onClick={() => onChange(v)}>
              {label}
            </button>
          ))}
        </span>
      );
    case 'number':
      if (f.role === 'guests') {
        const n = Number(value) || 0;
        return (
          <span className="df-stepper" role="group" {...a11y}>
            <button type="button" aria-label="Меньше" onClick={() => onChange(n > 1 ? String(n - 1) : '')}>
              −
            </button>
            <input inputMode="numeric" value={value} placeholder="—" onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} aria-labelledby={`df-${f.code}`} />
            <button type="button" aria-label="Больше" onClick={() => onChange(String(n + 1))}>
              +
            </button>
          </span>
        );
      }
      return <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} {...a11y} />;
    case 'money':
      return <input className="df-money" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} {...a11y} />;
    case 'date':
      return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} {...a11y} />;
    case 'datetime':
      return <input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} {...a11y} />;
    default:
      return isLongText(f, value) ? (
        <textarea rows={2} maxLength={5000} value={value} onChange={(e) => onChange(e.target.value)} {...a11y} />
      ) : (
        <input value={value} maxLength={5000} onChange={(e) => onChange(e.target.value)} {...a11y} />
      );
  }
}

/** Значения формы из полей (как пришли с сервера) — для сравнения «что изменили». */
export const initialValues = (fields: DealFormField[]): Record<string, string> =>
  Object.fromEntries(fields.filter((f) => !f.readOnly).map((f) => [f.code, f.value]));
