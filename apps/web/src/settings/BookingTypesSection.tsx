import { useState } from 'react';
import {
  PROGRAM_FROM_KEYWORD,
  renderTemplate,
  TEMPLATE_VARIABLES,
  unknownVariables,
  type BizprocImportDto,
  type BookingTypeRule,
  type ClientMessageStep,
} from '@btx24/shared';
import { apiGet } from '../api.js';
import { DiskPicker } from './DiskPicker.js';
import { move } from './group-form.js';
import { Section } from './GroupOptions.js';

/** Пример значений для предпросмотра. */
const SAMPLE: Record<string, string> = {
  client_name: 'Анна',
  date_start: '25.10.2026',
  time_start: '14:00',
  date_end: '25.10.2026',
  time_end: '18:00',
  program: 'Алатырь',
  guests: '4',
  house: 'Дом знахаря',
  amount: '45000',
  prepayment: '25000',
};

const newRule = (n: number): BookingTypeRule => ({
  id: `type${Date.now().toString(36)}${n}`,
  title: 'Новый тип',
  keywords: [],
  dealTypeValue: '',
  program: '',
  confirmation: [],
});

/**
 * Типы брони и подтверждение клиенту (замена БП 270): тип — по товарам сделки (первое
 * подошедшее правило), у каждого типа своя цепочка сообщений в открытую линию с файлами Диска.
 */
export function BookingTypesSection({
  rules,
  onChange,
}: {
  rules: BookingTypeRule[];
  onChange: (rules: BookingTypeRule[]) => void;
}) {
  const [templateId, setTemplateId] = useState('270');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [picker, setPicker] = useState<{ rule: number; step: number } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);

  const patch = (i: number, p: Partial<BookingTypeRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const patchStep = (i: number, k: number, p: Partial<ClientMessageStep>) =>
    patch(i, { confirmation: rules[i].confirmation.map((s, j) => (j === k ? { ...s, ...p } : s)) });

  const importBp = async () => {
    if (rules.length && !confirm('Заменить типы брони и сообщения на взятые из бизнес-процесса?')) return;
    setImporting(true);
    setError('');
    setNote('');
    try {
      const r = await apiGet<BizprocImportDto>(`/admin/bizproc-import?templateId=${encodeURIComponent(templateId)}`);
      onChange(r.rules);
      setNote(`Взято из «${r.templateName}»: типов — ${r.rules.length}. Проверьте и сохраните группу.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось прочитать бизнес-процесс');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Section title="Типы брони и сообщения клиенту" hint={`типов: ${rules.length}`} open={false}>
      <p className="muted">
        Тип брони определяется по названиям товаров сделки: правила проверяются сверху вниз, подходит первое, в товарах
        которого есть любое ключевое слово. После оплаты клиенту в открытую линию уходит цепочка сообщений этого типа.
        Тип не определён — сообщение не отправляется, менеджер получает предупреждение.
      </p>
      <div className="bp-import">
        <label>
          Перенести из бизнес-процесса №
          <input value={templateId} inputMode="numeric" onChange={(e) => setTemplateId(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button type="button" disabled={importing || !templateId} onClick={() => void importBp()}>
          {importing ? 'Читаю…' : 'Заполнить из БП'}
        </button>
      </div>
      {note && <p className="notice">{note}</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {rules.map((r, i) => (
        <div className="settings-subcard booking-type" key={r.id}>
          <div className="booking-type-head">
            <strong>
              {i + 1}. {r.title}
            </strong>
            <span className="row-actions">
              <button type="button" aria-label={`Выше: ${r.title}`} disabled={i === 0} onClick={() => onChange(move(rules, i, -1))}>
                ↑
              </button>
              <button
                type="button"
                aria-label={`Ниже: ${r.title}`}
                disabled={i === rules.length - 1}
                onClick={() => onChange(move(rules, i, 1))}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Удалить тип ${r.title}`}
                onClick={() => confirm(`Удалить тип «${r.title}»?`) && onChange(rules.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          </div>
          <div className="settings-grid">
            <label>
              Название типа
              <input value={r.title} maxLength={100} required onChange={(e) => patch(i, { title: e.target.value })} />
            </label>
            <label>
              Ключевые слова в товарах (через запятую)
              <input
                value={r.keywords.join(', ')}
                required
                onChange={(e) =>
                  patch(i, { keywords: e.target.value.split(',').map((k) => k.trimStart()).filter((k, j, a) => k || j === a.length - 1) })
                }
                onBlur={() => patch(i, { keywords: r.keywords.map((k) => k.trim()).filter(Boolean) })}
              />
            </label>
            <label>
              Поле сделки «Тип бронирования» (ID варианта)
              <input value={r.dealTypeValue} maxLength={50} onChange={(e) => patch(i, { dealTypeValue: e.target.value.trim() })} />
            </label>
            <label>
              Программа ({'{program}'})
              <select
                value={r.program === PROGRAM_FROM_KEYWORD ? PROGRAM_FROM_KEYWORD : 'text'}
                onChange={(e) => patch(i, { program: e.target.value === PROGRAM_FROM_KEYWORD ? PROGRAM_FROM_KEYWORD : '' })}
              >
                <option value={PROGRAM_FROM_KEYWORD}>Совпавшее ключевое слово</option>
                <option value="text">Текст</option>
              </select>
            </label>
            {r.program !== PROGRAM_FROM_KEYWORD && (
              <label>
                Текст программы
                <input value={r.program} maxLength={200} onChange={(e) => patch(i, { program: e.target.value })} />
              </label>
            )}
          </div>

          <h4>Подтверждение после оплаты</h4>
          {!r.confirmation.length && <p className="muted">Сообщений нет — клиенту ничего не уйдёт.</p>}
          <ol className="message-steps">
            {r.confirmation.map((s, k) => {
              const unknown = unknownVariables(s.text);
              return (
                <li key={k}>
                  <textarea
                    rows={Math.min(12, Math.max(2, s.text.split('\n').length))}
                    maxLength={4000}
                    value={s.text}
                    aria-label={`${r.title}: сообщение ${k + 1}`}
                    placeholder="Текст (можно пустой, если только файлы)"
                    onChange={(e) => patchStep(i, k, { text: e.target.value })}
                  />
                  {unknown.length > 0 && (
                    <p className="error">Неизвестные переменные: {unknown.map((u) => `{${u}}`).join(', ')}</p>
                  )}
                  <div className="step-files-row">
                    {s.files.map((f) => (
                      <span key={f.id} className="pill">
                        📎 {f.name}
                        <button
                          type="button"
                          aria-label={`Убрать файл ${f.name}`}
                          onClick={() => patchStep(i, k, { files: s.files.filter((x) => x.id !== f.id) })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <button type="button" className="link" onClick={() => setPicker({ rule: i, step: k })}>
                      + файл с Диска
                    </button>
                  </div>
                  <span className="row-actions">
                    <button type="button" aria-label="Выше" disabled={k === 0} onClick={() => patch(i, { confirmation: move(r.confirmation, k, -1) })}>
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="Ниже"
                      disabled={k === r.confirmation.length - 1}
                      onClick={() => patch(i, { confirmation: move(r.confirmation, k, 1) })}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Удалить сообщение ${k + 1}`}
                      onClick={() => patch(i, { confirmation: r.confirmation.filter((_, j) => j !== k) })}
                    >
                      ×
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="form-actions">
            <button type="button" className="link" onClick={() => patch(i, { confirmation: [...r.confirmation, { text: '', files: [] }] })}>
              + сообщение
            </button>
            <button type="button" className="link" onClick={() => setPreview(preview === i ? null : i)}>
              {preview === i ? 'Скрыть пример' : 'Пример для клиента'}
            </button>
          </div>
          {preview === i && (
            <div className="message-preview">
              {r.confirmation.map((s, k) => (
                <div key={k} className="cv-bubble">
                  {s.files.map((f) => (
                    <div key={f.id}>📎 {f.name}</div>
                  ))}
                  {s.text && (
                    <div className="cv-bubble-text">
                      {renderTemplate(s.text, { ...SAMPLE, program: r.program === PROGRAM_FROM_KEYWORD ? r.keywords[0] ?? '' : r.program })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rules, newRule(rules.length)])}>
        + тип брони
      </button>
      <details className="variables-help">
        <summary>Переменные в тексте</summary>
        <ul>
          {Object.entries(TEMPLATE_VARIABLES).map(([k, v]) => (
            <li key={k}>
              <code>{`{${k}}`}</code> — {v}
            </li>
          ))}
        </ul>
      </details>

      {picker && (
        <DiskPicker
          onClose={() => setPicker(null)}
          onPick={(f) => {
            const step = rules[picker.rule].confirmation[picker.step];
            if (!step.files.some((x) => x.id === f.id)) patchStep(picker.rule, picker.step, { files: [...step.files, f].slice(0, 10) });
            setPicker(null);
          }}
        />
      )}
    </Section>
  );
}
