import { useEffect, useState } from 'react';
import {
  DEFAULT_CLIENT_MESSAGE,
  DEFAULT_FAIL_MESSAGE,
  DEFAULT_SURCHARGE_MESSAGE,
  VARIABLE_MENU,
  type GroupDto,
  type GroupOptionsDto,
  type MessageTemplateDto,
  type TemplateVariablesDto,
} from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { TemplatesManager } from './TemplatesManager.js';

type Tab = 'chat' | 'auto' | 'vars';

/**
 * Шаблоны сообщений (кнопка «Шаблоны» на дашборде): шаблоны чатов — свои и общие; автоматические
 * сообщения групп (ссылка на оплату, доплата, снятие брони, подтверждение после оплаты);
 * переменные и проверка шаблона на сделке.
 */
export function TemplatesPage({ admin, onBack, onSettings }: { admin: boolean; onBack: () => void; onSettings?: () => void }) {
  const [tab, setTab] = useState<Tab>('chat');
  const [templates, setTemplates] = useState<MessageTemplateDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiGet<MessageTemplateDto[]>('/openlines/templates').then(setTemplates, (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить шаблоны'));
  }, []);

  return (
    <div className="app templates-page">
      <header className="toolbar">
        <div className="toolbar-title">
          <button aria-label="Назад" onClick={onBack}>
            ‹
          </button>
          <h1>Шаблоны</h1>
        </div>
      </header>
      <div className="segmented tabs-row" role="group" aria-label="Раздел">
        {(
          [
            ['chat', 'Шаблоны чатов'],
            ['auto', 'Автоматические'],
            ['vars', 'Переменные и проверка'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} aria-pressed={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {tab === 'chat' && (
        <section className="day-panel">
          <p className="muted">
            Свои шаблоны меняете вы; общие видят все сотрудники, меняют {admin ? 'администраторы (вы — администратор)' : 'администраторы приложения'}.
          </p>
          {templates ? <TemplatesManager embedded admin={admin} templates={templates} onChanged={setTemplates} onClose={onBack} /> : <p className="muted">Загрузка…</p>}
        </section>
      )}
      {tab === 'auto' && <AutoMessages admin={admin} onSettings={onSettings} />}
      {tab === 'vars' && <VariablesAndPreview templates={templates ?? []} />}
    </div>
  );
}

/** Автоматические сообщения групп — что уходит клиенту без участия сотрудника. */
function AutoMessages({ admin, onSettings }: { admin: boolean; onSettings?: () => void }) {
  const [groups, setGroups] = useState<GroupDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (admin) apiGet<GroupDto[]>('/admin/groups').then(setGroups, (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить группы'));
  }, [admin]);
  if (!admin) return <p className="notice">Автоматические сообщения групп настраивают администраторы приложения.</p>;
  if (error)
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  if (!groups) return <p className="muted">Загрузка…</p>;
  return (
    <div className="auto-messages">
      <p className="muted">
        Тексты правятся в ⚙ → группа → «Оплаты» и «Типы брони и сообщения клиенту». Переменные — во вкладке «Переменные и проверка».
        {onSettings && (
          <>
            {' '}
            <button className="link" onClick={onSettings}>
              Открыть настройки
            </button>
          </>
        )}
      </p>
      {groups.map((g) => {
        const p = (g.options as GroupOptionsDto | null)?.payments;
        const types = (g.options as GroupOptionsDto | null)?.bookingTypes ?? [];
        return (
          <section key={g.id} className="day-panel auto-group">
            <h3>{g.name}</h3>
            <Auto title="Ссылка на предоплату" when="после выставления счёта" text={p?.clientMessage || DEFAULT_CLIENT_MESSAGE} />
            <Auto title="Ссылка на доплату" when="после выставления счёта на доплату" text={p?.surchargeMessage || DEFAULT_SURCHARGE_MESSAGE} />
            <Auto title="Бронь снята — оплата не поступила" when={`через ${p?.timeoutMinutes ?? 90} минут без оплаты`} text={p?.failMessage ?? DEFAULT_FAIL_MESSAGE} />
            <h4>
              Подтверждение после оплаты —{' '}
              {p?.sendConfirmation ? <span className="pill paid">отправляется</span> : <span className="pill">выключено (пока работают БП 270/358)</span>}
            </h4>
            {!types.length && <p className="muted">Типы брони не настроены — подтверждение не уйдёт.</p>}
            {types.map((t) => (
              <details key={t.id} className="auto-type">
                <summary>
                  <b>{t.title}</b> <span className="muted">· товары: {t.keywords.join(', ')} · сообщений: {t.confirmation.length}</span>
                </summary>
                {t.confirmation.map((st, i) => (
                  <div key={i} className="auto-step">
                    {st.text && <pre>{st.text}</pre>}
                    {st.files.length > 0 && <p className="muted">Файлы: {st.files.map((f) => f.name).join(', ')}</p>}
                  </div>
                ))}
              </details>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Auto({ title, when, text }: { title: string; when: string; text: string }) {
  return (
    <div className="auto-step">
      <b>{title}</b> <span className="muted">· {when}</span>
      {text.trim() ? <pre>{text}</pre> : <p className="muted">Не отправляется (текст пуст).</p>}
    </div>
  );
}

/** Все переменные портала и проверка текста на конкретной сделке. */
function VariablesAndPreview({ templates }: { templates: MessageTemplateDto[] }) {
  const [vars, setVars] = useState<TemplateVariablesDto | null>(null);
  const [text, setText] = useState('Мы с радостью подтверждаем Вашу бронь на имя {{Контакт: Имя}}:\n* Дата и время: {{Дата начала визита}} {{Время начала визита}}\n* Программа: {=Variable:programm > printable}\n* Стоимость: {{Сумма}} рублей');
  const [dealId, setDealId] = useState('');
  const [result, setResult] = useState<{ texts: string[]; unresolved: string[] } | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    apiGet<TemplateVariablesDto>('/openlines/templates/variables').then(setVars, () => undefined);
  }, []);
  const check = async () => {
    setError('');
    try {
      setResult(await apiPost('/openlines/templates/preview', { texts: [text], dealId: Number(dealId) }));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : 'Не удалось проверить');
    }
  };
  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(token);
    } catch {
      setCopied('');
    }
  };
  const chip = (token: string, label?: string) => (
    <button key={token} type="button" className={`var-chip${copied === token ? ' copied' : ''}`} title={label ?? 'Скопировать'} onClick={() => void copy(token)}>
      {token}
    </button>
  );
  return (
    <div className="vars-page">
      <section className="day-panel">
        <h3>Проверить шаблон на сделке</h3>
        {templates.length > 0 && (
          <label>
            Взять текст из шаблона{' '}
            <select value="" onChange={(e) => setText(templates.find((t) => t.id === e.target.value)?.steps.map((s) => s.text).join('\n\n') ?? text)}>
              <option value="">—</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <textarea className="vars-text" rows={7} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="form-actions">
          <input aria-label="Номер сделки" inputMode="numeric" placeholder="Номер сделки" value={dealId} onChange={(e) => setDealId(e.target.value.replace(/\D/g, ''))} />
          <button className="primary" disabled={!dealId || !text.trim()} onClick={() => void check()}>
            Проверить
          </button>
        </div>
        {error && <p className="notice error">{error}</p>}
        {result && (
          <>
            <pre className="vars-result">{result.texts[0]}</pre>
            {result.unresolved.length > 0 ? (
              <p className="notice">Не подставлено (нет такого поля или оно пустое в сделке): {result.unresolved.join(', ')}</p>
            ) : (
              <p className="muted">Все переменные подставлены.</p>
            )}
          </>
        )}
      </section>
      <section className="day-panel">
        <h3>Переменные</h3>
        <p className="muted">Нажмите, чтобы скопировать. Поля сделки и контакта — по названию, как в Битрикс24.</p>
        <h4>Простые переменные</h4>
        <div className="var-chips">{VARIABLE_MENU.map((v) => chip(v.token, v.label))}</div>
        <h4>Приложение и БП</h4>
        <div className="var-chips">{vars?.app.map((v) => chip(v.token, v.label))}</div>
        <h4>Поля сделки</h4>
        <div className="var-chips">{vars?.deal.map((t) => chip(`{{${t}}}`))}</div>
        <h4>Поля контакта</h4>
        <div className="var-chips">{vars?.contact.map((t) => chip(`{{Контакт: ${t}}}`))}</div>
        {!vars && <p className="muted">Загрузка…</p>}
      </section>
    </div>
  );
}
