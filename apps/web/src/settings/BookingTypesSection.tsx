import { useState } from 'react';
import {
  clientFileKey,
  isCertificateRule,
  PROGRAM_FROM_KEYWORD,
  renderTemplate,
  TEMPLATE_VARIABLES,
  type BizprocImportDto,
  type BookingTypeRule,
} from '@btx24/shared';
import { apiGet } from '../api.js';
import { MessageStepsEditor } from './MessageStepsEditor.js';
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
  products: 'Программа «Алатырь» (4 часа), Веник × 2',
  deal_type: 'Программы',
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
  required = false,
  onRequired,
  dealKinds = false,
  onDealKinds,
  onUploadingChange,
}: {
  rules: BookingTypeRule[];
  onChange: (rules: BookingTypeRule[]) => void;
  /** Тип брони обязателен при создании брони. */
  required?: boolean;
  onRequired?: (v: boolean) => void;
  /** Шаг «Тип сделки» в мастере брони (сертификат / посещение / сертификатом / без оплаты). */
  dealKinds?: boolean;
  onDealKinds?: (v: boolean) => void;
  onUploadingChange?: (busy: boolean) => void;
}) {
  const [templateId, setTemplateId] = useState('270');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<number | null>(null);

  const patch = (i: number, p: Partial<BookingTypeRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  /** Редактор цепочки сообщений типа брони: подтверждение после оплаты или сообщение со ссылкой на оплату. */
  const stepsEditor = (i: number, r: BookingTypeRule, field: 'confirmation' | 'prepayment', empty: string) => (
    <MessageStepsEditor steps={r[field] ?? []} onChange={(v) => patch(i, { [field]: v })} label={`${r.title}${field === 'prepayment' ? ': оплата' : ''}`} empty={empty} onUploadingChange={onUploadingChange} />
  );

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
        Тип не определён — сообщение не отправляется, менеджер получает предупреждение. Менеджер может выбрать тип в
        форме брони; не выбрал — тип определяется по товарам, а если товары добавили позже, поле «Тип бронирования» в сделке
        заполнится само.
      </p>
      {onRequired && (
        <label className="check switch-row">
          <input type="checkbox" role="switch" checked={required} onChange={(e) => onRequired(e.target.checked)} />
          <b>Тип брони обязателен</b>
          <span className="muted"> — не выбран и не определился по товарам: бронь не создаётся</span>
        </label>
      )}
      {onDealKinds && (
        <label className="check switch-row">
          <input type="checkbox" role="switch" checked={dealKinds} onChange={(e) => onDealKinds(e.target.checked)} />
          <b>Шаг «Тип сделки» в мастере брони</b>
          <span className="muted">
            {' '}
            — покупка сертификата, бронирование посещения (ссылка на предоплату), бронирование сертификатом (ссылка — по решению
            менеджера), без оплаты; тип бронирования при посещении обязателен
          </span>
        </label>
      )}
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
            <label className="check">
              <input type="checkbox" checked={!!r.unavailable} onChange={(e) => patch(i, { unavailable: e.target.checked || undefined })} />
              Сейчас недоступен для бронирования
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
          <h4>Подтверждение после оплаты</h4>
          {stepsEditor(i, r, 'confirmation', 'Сообщений нет — клиенту ничего не уйдёт.')}
          <div className="form-actions">
            <button type="button" className="link" onClick={() => setPreview(preview === i ? null : i)}>
              {preview === i ? 'Скрыть пример' : 'Пример для клиента'}
            </button>
          </div>
          {preview === i && (
            <div className="message-preview">
              {r.confirmation.map((s, k) => (
                <div key={k} className="cv-bubble">
                  {s.files.map((f) => (
                    <div key={clientFileKey(f)}>📎 {f.name}</div>
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

          <h4>Сообщение со ссылкой на оплату</h4>
          <p className="muted">
            Уходит клиенту с предоплатой, если в группе не выбран шаблон оплаты. <code>{'{link}'}</code> — ссылка, <code>{'{prepayment}'}</code> — сумма. Пусто — стандартный текст {isCertificateRule(r.title) ? 'сертификата' : 'брони'} и файлы из подтверждения.
          </p>
          {stepsEditor(i, r, 'prepayment', 'Не задано — уходит стандартный текст.')}
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

    </Section>
  );
}
