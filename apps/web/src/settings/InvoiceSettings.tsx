import { useEffect, useState } from 'react';
import { suggestInvoiceConfig, type InvoiceConfig, type InvoiceMetaDto } from '@btx24/shared';
import { apiGet } from '../api.js';

/**
 * Смарт-счёт направления (ADR 0009): куда приложение создаёт счёт, из какого поля берёт ссылку на
 * оплату (её ставит портал) и какие постоянные поля заполняет («Тип счёта», «Тип сделки»).
 */
export function InvoiceSettings({ value, onChange }: { value: InvoiceConfig | undefined; onChange: (v: InvoiceConfig | undefined) => void }) {
  const [meta, setMeta] = useState<InvoiceMetaDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiGet<InvoiceMetaDto>('/admin/invoice-meta').then(setMeta, (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить счета портала'));
  }, []);
  if (error)
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  if (!meta) return <p className="muted">Загрузка настроек счетов портала…</p>;
  if (!value)
    return (
      <div className="settings-subcard">
        <p className="muted">Счёт не настроен — кнопка «Счёт и ссылка на оплату» в чате и после брони работать не будет.</p>
        <button type="button" onClick={() => onChange(suggestInvoiceConfig(meta) ?? undefined)} disabled={!meta.categories.length}>
          Настроить счёт
        </button>
      </div>
    );
  const cat = meta.categories.find((c) => c.id === value.categoryId) ?? meta.categories[0];
  const stage = (label: string, key: 'prepaymentStageId' | 'surchargeStageId') => (
    <label>
      {label}
      <select value={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.value })}>
        {!cat?.stages.some((s) => s.id === value[key]) && <option value={value[key]}>{value[key] || 'Не выбрано'}</option>}
        {cat?.stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
  const enums = meta.fields.filter((f) => f.type === 'enumeration');
  return (
    <div className="settings-subcard">
      <div className="settings-grid">
        <label>
          Воронка счетов
          <select value={value.categoryId} onChange={(e) => onChange({ ...value, categoryId: Number(e.target.value) })}>
            {meta.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {stage('Стадия счёта на предоплату', 'prepaymentStageId')}
        {stage('Стадия счёта на доплату', 'surchargeStageId')}
        <label>
          Поле со ссылкой на оплату
          <select value={value.linkField} onChange={(e) => onChange({ ...value, linkField: e.target.value })}>
            {!value.linkField && <option value="">Не выбрано</option>}
            {meta.fields
              .filter((f) => f.type !== 'enumeration')
              .map((f) => (
                <option key={f.code} value={f.code}>
                  {f.title}
                </option>
              ))}
          </select>
          <span className="muted">Ссылку в это поле ставит портал (робот счёта, платёжная система).</span>
        </label>
        {enums.map((f) => (
          <label key={f.code}>
            {f.title}
            <select
              value={String(value.fields[f.code] ?? '')}
              onChange={(e) => {
                const fields = { ...value.fields };
                if (e.target.value) fields[f.code] = Number(e.target.value);
                else delete fields[f.code];
                onChange({ ...value, fields });
              }}
            >
              <option value="">Не заполнять</option>
              {f.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.value}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <button type="button" className="link" onClick={() => onChange(undefined)}>
        Отключить счёт
      </button>
    </div>
  );
}
