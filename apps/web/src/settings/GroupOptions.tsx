import { useState, type ReactNode } from 'react';
import type { CatalogDto, DealFieldInfo, DealStageItem, GroupOptionsDto, NamedBitrixItem } from '@btx24/shared';
import { move, newDealField, setResourceDefaults } from './group-form.js';
import { CatalogSections, sectionSummary } from './CatalogSections.js';

type Ref<T> = { data: T | null; error: string };

/** Сворачиваемый блок настроек (как «Развернуть/Свернуть» в прототипе). */
export function Section({
  title,
  hint,
  open = true,
  children,
}: {
  title: string;
  hint?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="settings-card" open={open}>
      <summary>
        <span>
          <strong>{title}</strong>
          {hint && <span className="muted"> · {hint}</span>}
        </span>
      </summary>
      <div className="settings-card-body">{children}</div>
    </details>
  );
}

function RefNotice({ r, loading }: { r: Ref<unknown>; loading: string }) {
  if (r.error)
    return (
      <p className="notice error" role="alert">
        {r.error}
      </p>
    );
  return r.data ? null : <p className="muted">{loading}</p>;
}

function StageSelect({
  label,
  value,
  stages,
  onChange,
}: {
  label: string;
  value: string;
  stages: DealStageItem[] | null;
  onChange: (v: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Не выбрано</option>
        {value && !stages?.some((s) => s.id === value) && <option value={value}>Текущая стадия · {value}</option>}
        {stages?.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} · {s.id}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Оплаты без бизнес-процессов: стадии и таймаут. Шаблоны сообщений появятся вместе с оплатами. */
export function PaymentsSection({
  payments,
  stages,
  onChange,
}: {
  payments: GroupOptionsDto['payments'];
  stages: Ref<DealStageItem[]>;
  onChange: (p: GroupOptionsDto['payments']) => void;
}) {
  const step = (key: 'prepayment' | 'surcharge', title: string) => (
    <div className="settings-subcard">
      <strong>{title}</strong>
      <StageSelect
        label={`Стадия ${key === 'prepayment' ? 'предоплаты' : 'доплаты'}`}
        value={payments[key].stageId}
        stages={stages.data}
        onChange={(stageId) => onChange({ ...payments, [key]: { ...payments[key], stageId } })}
      />
      <label className="check">
        <input
          type="checkbox"
          checked={payments[key].moveStage}
          onChange={(e) => onChange({ ...payments, [key]: { ...payments[key], moveStage: e.target.checked } })}
        />
        Переносить сделку в эту стадию при отправке ссылки
      </label>
    </div>
  );
  return (
    <Section title="Оплаты" hint="стадии и ожидание оплаты">
      <RefNotice r={stages} loading="Загрузка стадий воронки…" />
      <div className="settings-pair">
        {step('prepayment', 'Предоплата')}
        {step('surcharge', 'Доплата')}
      </div>
      <h4>Действия после оплаты</h4>
      <div className="settings-grid">
        <label>
          Ожидание оплаты, минут
          <input
            type="number"
            min={1}
            max={10080}
            required
            value={payments.timeoutMinutes}
            onChange={(e) => onChange({ ...payments, timeoutMinutes: Number(e.target.value) })}
          />
        </label>
        <StageSelect
          label="Стадия при успешной оплате"
          value={payments.successStageId}
          stages={stages.data}
          onChange={(successStageId) => onChange({ ...payments, successStageId })}
        />
        <StageSelect
          label="Стадия при неоплате"
          value={payments.failStageId}
          stages={stages.data}
          onChange={(failStageId) => onChange({ ...payments, failStageId })}
        />
      </div>
      <p className="muted">
        Без бизнес-процессов: ссылку, смену стадии и снятие брони при неоплате выполняет приложение. Шаблоны сообщений
        настраиваются вместе с отправкой ссылок.
      </p>
    </Section>
  );
}

/** Ресурсы группы и товары, которые подставляются в бронь ресурса по умолчанию. */
export function ResourcesSection({
  resources,
  resourceIds,
  defaults,
  catalog,
  onResources,
  onDefaults,
}: {
  resources: NamedBitrixItem[];
  resourceIds: number[];
  defaults: GroupOptionsDto['resourceDefaults'];
  catalog: Ref<CatalogDto>;
  onResources: (ids: number[]) => void;
  onDefaults: (d: GroupOptionsDto['resourceDefaults']) => void;
}) {
  // Пустые строки «выберите товар» живут только в форме, в настройки не попадают.
  const [blank, setBlank] = useState<Record<number, number>>({});
  const products = catalog.data?.products ?? [];
  return (
    <Section title="Ресурсы и товар по умолчанию" hint={`выбрано: ${resourceIds.length}`} open={false}>
      <RefNotice r={catalog} loading="Загрузка каталога товаров…" />
      <ul className="resource-settings">
        {resources.map((r) => {
          const checked = resourceIds.includes(r.id);
          const rows = defaults[String(r.id)] ?? [];
          const extra = blank[r.id] ?? 0;
          const save = (next: { productId: number; quantity: number }[]) =>
            onDefaults(setResourceDefaults(defaults, r.id, next));
          return (
            <li key={r.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) =>
                    onResources(e.target.checked ? [...resourceIds, r.id] : resourceIds.filter((id) => id !== r.id))
                  }
                />
                {r.name} <span className="muted">#{r.id}</span>
              </label>
              {checked && (
                <div className="default-products">
                  {[...rows, ...Array.from({ length: extra }, () => ({ productId: 0, quantity: 1 }))].map((row, i) => (
                    <div className="default-product" key={i}>
                      <select
                        aria-label={`Товар по умолчанию для ${r.name}`}
                        value={row.productId || ''}
                        onChange={(e) => {
                          const productId = Number(e.target.value);
                          if (i >= rows.length) {
                            setBlank((b) => ({ ...b, [r.id]: Math.max(0, extra - 1) }));
                            save([...rows, { productId, quantity: row.quantity }]);
                          } else save(rows.map((x, j) => (j === i ? { ...x, productId } : x)));
                        }}
                      >
                        <option value="">Не выбран</option>
                        {row.productId > 0 && !products.some((p) => p.id === row.productId) && (
                          <option value={row.productId}>Товар #{row.productId}</option>
                        )}
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {p.price !== null ? ` · ${p.price}` : ''}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        aria-label="Количество по умолчанию"
                        value={row.quantity}
                        disabled={i >= rows.length}
                        onChange={(e) =>
                          save(
                            rows.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x)),
                          )
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          i >= rows.length
                            ? setBlank((b) => ({ ...b, [r.id]: Math.max(0, extra - 1) }))
                            : save(rows.filter((_, j) => j !== i))
                        }
                      >
                        Удалить
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setBlank((b) => ({ ...b, [r.id]: extra + 1 }))}>
                    Добавить товар
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** Разделы каталога, доступные в группе (пусто — все). */
export function CatalogSection({
  selected,
  catalog,
  onChange,
}: {
  selected: string[];
  catalog: Ref<CatalogDto>;
  onChange: (ids: string[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <Section title="Разделы товарного каталога" hint={`выбрано: ${selected.length}`} open={false}>
      <div className="form-actions">
        <span>
          <b>{sectionSummary(selected, catalog.data?.sections ?? [])}</b>
        </span>
        <button type="button" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
          {picking ? 'Готово' : 'Выбрать'}
        </button>
      </div>
      {picking && (
        <>
          <RefNotice r={catalog} loading="Загрузка разделов…" />
          {catalog.data && <CatalogSections sections={catalog.data.sections} selected={selected} onChange={onChange} />}
        </>
      )}
    </Section>
  );
}

const FLAGS = [
  ['showCreate', 'С', 'Карточка создания'],
  ['showView', 'П', 'Карточка просмотра'],
  ['showList', 'О', 'Общий список и календарь'],
] as const;

/** Поля сделки группы: обязательность, «2 в линии», порядок и видимость (С / П / О). */
export function DealFieldsSection({
  fields,
  available,
  onChange,
}: {
  fields: GroupOptionsDto['dealFields'];
  available: Ref<DealFieldInfo[]>;
  onChange: (f: GroupOptionsDto['dealFields']) => void;
}) {
  const [pick, setPick] = useState('');
  const label = (code: string) =>
    fields.find((f) => f.name === code)?.title || available.data?.find((f) => f.code === code)?.label || code;
  const patch = (i: number, p: Partial<GroupOptionsDto['dealFields'][number]>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  return (
    <Section title="Поля сделки" hint={`полей: ${fields.length}`} open={false}>
      <RefNotice r={available} loading="Загрузка полей сделки…" />
      <div className="form-actions">
        <select aria-label="Поле сделки" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Выберите поле сделки</option>
          {available.data
            ?.filter((f) => !f.readOnly && !fields.some((x) => x.name === f.code))
            .map((f) => (
              <option key={f.code} value={f.code}>
                {f.label}
              </option>
            ))}
        </select>
        <button
          type="button"
          disabled={!pick}
          onClick={() => {
            onChange([...fields, newDealField(pick)]);
            setPick('');
          }}
        >
          Добавить поле
        </button>
      </div>
      <p className="muted">С — карточка создания, П — карточка просмотра, О — общий список и календарь.</p>
      <ul className="deal-field-rows">
        {fields.map((f, i) => (
          <li key={f.name}>
            <strong>{label(f.name)}</strong>
            <span className="deal-field-actions">
              <button
                type="button"
                aria-label={`Выше: ${label(f.name)}`}
                disabled={i === 0}
                onClick={() => onChange(move(fields, i, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Ниже: ${label(f.name)}`}
                disabled={i === fields.length - 1}
                onClick={() => onChange(move(fields, i, 1))}
              >
                ↓
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => patch(i, { required: e.target.checked })}
                />
                обязательно
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={f.inlineNext}
                  onChange={(e) => patch(i, { inlineNext: e.target.checked })}
                />
                2 в линии
              </label>
              {FLAGS.map(([key, short, title]) => (
                <label className="check" key={key} title={title}>
                  <input
                    type="checkbox"
                    aria-label={`${title}: ${label(f.name)}`}
                    checked={f[key]}
                    onChange={(e) => patch(i, { [key]: e.target.checked })}
                  />
                  {short}
                </label>
              ))}
              <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))}>
                Удалить
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
