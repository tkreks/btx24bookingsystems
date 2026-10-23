import { useEffect, useState } from 'react';
import type { AutoMessageRule, MessageTemplateDto } from '@btx24/shared';
import { apiGet } from '../api.js';
import { Section } from './GroupOptions.js';

const newRule = (): AutoMessageRule => ({
  id: `r${Date.now().toString(36)}`,
  enabled: true,
  name: 'Подтверждение брони',
  trigger: 'before_start',
  hoursBefore: 24,
  windowFrom: '09:00',
  windowTo: '22:00',
  templateId: '',
});

/**
 * Автоматические рассылки группы: «за N часов до начала брони, только с … до …» — системный шаблон
 * (назначение «Автоматическая рассылка») клиенту в чат сделки. Срок вне окна сдвигается в окно того же
 * дня: бронь в 23:30 — накануне до 22:00, в 07:00 — накануне с 9:00.
 */
export function AutoMessagesSection({ rules, onChange }: { rules: AutoMessageRule[]; onChange: (rules: AutoMessageRule[]) => void }) {
  const [templates, setTemplates] = useState<MessageTemplateDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiGet<MessageTemplateDto[]>('/openlines/templates').then(
      (all) => setTemplates(all.filter((t) => t.purpose === 'auto')),
      (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить шаблоны'),
    );
  }, []);
  const patch = (i: number, p: Partial<AutoMessageRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <Section title="Автоматические рассылки" hint={rules.length ? `правил: ${rules.length}` : 'нет'} open={false}>
      <p className="muted">
        Сообщение клиенту в чат сделки по клиентским броням группы — от имени ответственного за сделку. Одно сообщение на бронь; бронь, сделанная
        позже срока, рассылку не получает. Шаблоны — «Шаблоны» → «Создать шаблон» → назначение «Автоматическая рассылка».
      </p>
      {error && <p className="notice error">{error}</p>}
      {templates && !templates.length && <p className="notice">Системных шаблонов рассылки пока нет — сначала создайте шаблон.</p>}
      <ul className="auto-rules">
        {rules.map((r, i) => (
          <li key={r.id} className={r.enabled ? '' : 'off'}>
            <div className="auto-rule-head">
              <label className="check">
                <input type="checkbox" checked={r.enabled} onChange={(e) => patch(i, { enabled: e.target.checked })} />
                Включено
              </label>
              <input aria-label="Название рассылки" value={r.name} maxLength={100} onChange={(e) => patch(i, { name: e.target.value })} />
              <button type="button" className="danger-outline" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                Удалить
              </button>
            </div>
            <div className="auto-rule-grid">
              <label>
                За сколько часов до начала брони
                <input type="number" min={0.5} max={336} step={0.5} value={r.hoursBefore} onChange={(e) => patch(i, { hoursBefore: Number(e.target.value) })} />
              </label>
              <label>
                Отправлять с
                <input type="time" value={r.windowFrom} onChange={(e) => patch(i, { windowFrom: e.target.value })} />
              </label>
              <label>
                до
                <input type="time" value={r.windowTo} onChange={(e) => patch(i, { windowTo: e.target.value })} />
              </label>
              <label>
                Шаблон
                <select value={r.templateId} disabled={!templates} onChange={(e) => patch(i, { templateId: e.target.value })}>
                  <option value="">— выберите —</option>
                  {r.templateId && templates && !templates.some((t) => t.id === r.templateId) && <option value={r.templateId}>Шаблон удалён — выберите другой</option>}
                  {templates?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {r.windowFrom >= r.windowTo && <p className="notice error">Окно отправки: «с» должно быть раньше «до».</p>}
            {!r.templateId && <p className="notice error">Выберите шаблон — без него рассылку не сохранить.</p>}
            {templates?.find((t) => t.id === r.templateId) && (
              <textarea
                rows={2}
                readOnly
                aria-label={`Текст рассылки «${r.name}»`}
                value={templates
                  .find((t) => t.id === r.templateId)!
                  .steps.map((st) => [st.text, ...st.files.map((f) => `📎 ${f.name}`)].filter(Boolean).join('\n'))
                  .join('\n\n')}
              />
            )}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => onChange([...rules, newRule()])}>
        + Добавить рассылку
      </button>
    </Section>
  );
}
