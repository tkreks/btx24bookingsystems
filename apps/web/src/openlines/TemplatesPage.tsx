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
import { apiGet, apiPost, apiPut } from '../api.js';
import { groupSettings } from '../settings/group-form.js';
import { newStep } from './chain.js';
import { TemplatesManager } from './TemplatesManager.js';

type Tab = 'chat' | 'system' | 'vars';

/**
 * Шаблоны сообщений (кнопка «Шаблоны» на дашборде): шаблоны чатов — свои и общие; системные
 * сообщения групп списком — какой шаблон когда уходит (ссылка на оплату, доплата, отказ, рассылки, подтверждение);
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
            ['chat', 'Шаблоны'],
            ['system', 'Системные'],
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
      {tab === 'system' && <SystemTemplates admin={admin} onSettings={onSettings} templates={templates ?? []} onTemplates={setTemplates} />}
      {tab === 'vars' && <VariablesAndPreview templates={templates ?? []} />}
    </div>
  );
}

type Trigger = {
  key: string;
  group: GroupDto;
  /** Что за сообщение и когда уходит. */
  title: string;
  when: string;
  /** Системный шаблон или текст в настройках группы. */
  template: MessageTemplateDto | null;
  text: string;
  files: number;
  enabled: boolean;
  /** Можно открыть в редакторе шаблонов: свой шаблон или новый, назначаемый группе. */
  edit?: { purpose: 'payment' | 'auto'; field?: 'prepaymentTemplateId' | 'surchargeTemplateId' };
};

/** Системные сообщения групп: какой шаблон и при каких условиях уходит клиенту без участия сотрудника. */
export function systemTriggers(groups: GroupDto[], templates: MessageTemplateDto[]): Trigger[] {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const files = (t: MessageTemplateDto | null) => t?.steps.reduce((n, st) => n + st.files.length, 0) ?? 0;
  return groups.flatMap((g) => {
    const o = g.options as GroupOptionsDto | null;
    const p = o?.payments;
    const pre = p?.prepaymentTemplateId ? (byId.get(p.prepaymentTemplateId) ?? null) : null;
    const sur = p?.surchargeTemplateId ? (byId.get(p.surchargeTemplateId) ?? null) : null;
    const list: Trigger[] = [
      { key: `${g.id}:pre`, group: g, title: 'Ссылка на предоплату', when: `Счёт на предоплату выставлен и портал выдал ссылку${p?.timeoutMinutes ? ` · на оплату ${p.timeoutMinutes} мин` : ''}`, template: pre, text: pre ? '' : p?.clientMessage || DEFAULT_CLIENT_MESSAGE, files: files(pre), enabled: !!p?.invoice, edit: { purpose: 'payment', field: 'prepaymentTemplateId' } },
      { key: `${g.id}:sur`, group: g, title: 'Ссылка на доплату', when: 'Счёт на доплату выставлен и портал выдал ссылку', template: sur, text: sur ? '' : p?.surchargeMessage || DEFAULT_SURCHARGE_MESSAGE, files: files(sur), enabled: !!p?.invoice, edit: { purpose: 'payment', field: 'surchargeTemplateId' } },
      { key: `${g.id}:fail`, group: g, title: 'Бронь снята — оплата не поступила', when: `Предоплата не поступила за ${p?.timeoutMinutes ?? 90} мин после отправки ссылки`, template: null, text: p?.failMessage ?? DEFAULT_FAIL_MESSAGE, files: 0, enabled: !!p?.invoice && (p?.failMessage ?? DEFAULT_FAIL_MESSAGE).trim() !== '' },
    ];
    for (const r of o?.autoMessages ?? []) {
      const t = byId.get(r.templateId) ?? null;
      list.push({ key: `${g.id}:auto:${r.id}`, group: g, title: r.name || 'Рассылка', when: `За ${r.hoursBefore} ч до начала брони, с ${r.windowFrom} до ${r.windowTo}`, template: t, text: t ? '' : 'Шаблон не выбран или удалён', files: files(t), enabled: r.enabled && !!t, edit: t ? { purpose: 'auto' } : undefined });
    }
    for (const bt of o?.bookingTypes ?? [])
      if (bt.confirmation.length)
        list.push({ key: `${g.id}:conf:${bt.id}`, group: g, title: `Подтверждение · ${bt.title}`, when: `Предоплата поступила, тип брони «${bt.title}»${bt.keywords.length ? ` (товары: ${bt.keywords.join(', ')})` : ''}`, template: null, text: bt.confirmation.map((st) => st.text).filter(Boolean).join('\n\n'), files: bt.confirmation.reduce((n, st) => n + st.files.length, 0), enabled: !!p?.sendConfirmation });
    return list;
  });
}

/**
 * Системные шаблоны (решение владельца 2026-10-26) — списком: что уходит клиенту, когда, каким шаблоном.
 * «Изменить» — редактор шаблонов; у сообщения об оплате со стандартным текстом — новый системный шаблон
 * с этим текстом, который сразу назначается группе.
 */
function SystemTemplates({ admin, onSettings, templates, onTemplates }: { admin: boolean; onSettings?: () => void; templates: MessageTemplateDto[]; onTemplates: (t: MessageTemplateDto[]) => void }) {
  const [groups, setGroups] = useState<GroupDto[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Trigger | null>(null);
  const load = () => apiGet<GroupDto[]>('/admin/groups').then(setGroups, (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить группы'));
  useEffect(() => {
    if (admin) void load();
  }, [admin]);
  if (!admin) return <p className="notice">Системные сообщения групп настраивают администраторы приложения.</p>;
  if (error) return <p className="notice error" role="alert">{error}</p>;
  if (!groups) return <p className="muted">Загрузка…</p>;

  if (editing?.edit) {
    const t = editing.template;
    const open = t
      ? { id: t.id, name: t.name, purpose: t.purpose, steps: t.steps.map((st) => newStep(st.text, st.files)) }
      : { id: null, name: `${editing.title} · ${editing.group.name}`, purpose: editing.edit.purpose, steps: [newStep(editing.text)] };
    const field = editing.edit.field;
    return (
      <section className="day-panel">
        <p className="muted">
          {editing.title} · группа «{editing.group.name}» — {editing.when.toLowerCase()}.
          {!t && ' Сохранённый шаблон сразу станет шаблоном этого сообщения в группе.'}
        </p>
        <TemplatesManager
          embedded
          admin
          templates={templates}
          onChanged={onTemplates}
          onClose={() => setEditing(null)}
          open={open}
          onSaved={async (saved) => {
            if (t || !field) return;
            const g = editing.group;
            const o = (g.options ?? {}) as GroupOptionsDto;
            await apiPut<GroupDto>(`/admin/groups/${encodeURIComponent(g.id)}`, { ...groupSettings(g), options: { ...o, payments: { ...o.payments, [field]: saved.id } } });
            await load();
          }}
          onDone={() => setEditing(null)}
        />
      </section>
    );
  }

  const triggers = systemTriggers(groups, templates);
  const used = new Set(triggers.map((x) => x.template?.id).filter(Boolean));
  const unused = templates.filter((t) => t.purpose !== 'chat' && !used.has(t.id));
  return (
    <section className="day-panel system-templates">
      <p className="muted">
        Что уходит клиенту без участия сотрудника. Текст отказа и подтверждения меняются в настройках группы.
        {onSettings && (
          <>
            {' '}
            <button className="link" onClick={onSettings}>
              Открыть настройки
            </button>
          </>
        )}
      </p>
      <ul className="system-list">
        {triggers.map((x) => (
          <li key={x.key} className={x.enabled ? '' : 'off'}>
            <div className="system-main">
              <span className="system-title">
                <b>{x.title}</b>
                <span className="pill">{x.group.name}</span>
                {!x.enabled && <span className="pill">не отправляется</span>}
              </span>
              <span className="system-when">{x.when}</span>
              <span className="system-source muted">
                {x.template ? `Шаблон «${x.template.name}»` : x.edit?.field ? 'Стандартный текст' : 'Текст в настройках группы'}
                {x.files > 0 && ` · 📎 ${x.files}`}
              </span>
            </div>
            {x.edit ? (
              <button type="button" onClick={() => setEditing(x)}>
                {x.template ? 'Изменить' : 'Создать шаблон'}
              </button>
            ) : (
              onSettings && (
                <button type="button" className="link" onClick={onSettings}>
                  В настройки
                </button>
              )
            )}
          </li>
        ))}
        {unused.map((t) => (
          <li key={t.id} className="off">
            <div className="system-main">
              <span className="system-title">
                <b>{t.name}</b>
                <span className="pill">не назначен</span>
              </span>
              <span className="system-when">Не используется ни в одной группе</span>
            </div>
            <button type="button" onClick={() => setEditing({ key: t.id, group: groups[0], title: t.name, when: 'Не используется', template: t, text: '', files: 0, enabled: false, edit: { purpose: t.purpose === 'auto' ? 'auto' : 'payment' } })}>
              Изменить
            </button>
          </li>
        ))}
      </ul>
    </section>
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
