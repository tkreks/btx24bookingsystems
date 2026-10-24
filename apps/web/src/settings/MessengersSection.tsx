import { useCallback, useEffect, useState } from 'react';
import { MESSENGER_KINDS, MESSENGER_STATE_LABELS, normalizeMessengerPhone, type GroupDto, type MessengerAuthMode, type MessengerDto, type MessengerKind } from '@btx24/shared';
import { apiDelete, apiGet, apiPost, apiPut } from '../api.js';
import { fmtDateTime } from '../format.js';
import { MessengerScreen } from './MessengerScreen.js';
import { MessengerChatsDialog } from '../messengers/MessengerChatsDialog.js';
import { MessengerLinkDialog } from '../messengers/MessengerLinkDialog.js';

const KIND_ICONS: Record<MessengerKind, string> = { whatsapp: '🟢', telegram: '✈️', max: '🟣' };
const label = (kind: MessengerKind) => MESSENGER_KINDS.find((k) => k.kind === kind)?.label ?? kind;
/** Пока идёт вход или запуск — обновляем часто. */
const BUSY_STATES = new Set(['starting', 'pairing', 'qr', 'authenticated']);
const fmtPhone = (p: string) => `+${p}`;

/**
 * ⚙ → «Мессенджеры» (ADR 0014): подключённые номера и мастер «Добавить» — мессенджер → номер → вход.
 * Подключаются WhatsApp и Telegram (WhatsApp Web / Telegram Web в браузере сервиса); MAX — следующим.
 * Дальше мессенджеры сопоставляются с открытыми линиями Битрикс24 — чтобы написать клиенту первым.
 */
export function MessengersSection({ timezone }: { timezone: string }) {
  const [items, setItems] = useState<MessengerDto[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [chatsOf, setChatsOf] = useState<MessengerDto | null>(null);
  const [linkOf, setLinkOf] = useState<MessengerDto | null>(null);
  const [groups, setGroups] = useState<GroupDto[]>([]);
  useEffect(() => void apiGet<GroupDto[]>('/admin/groups').then(setGroups, () => undefined), []);

  const load = useCallback(
    () =>
      apiGet<MessengerDto[]>('/admin/messengers').then(
        (v) => {
          setItems(v);
          setError('');
        },
        (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить мессенджеры'),
      ),
    [],
  );
  useEffect(() => void load(), [load]);
  const waiting = items?.some((m) => BUSY_STATES.has(m.state)) ?? false;
  useEffect(() => {
    const timer = setInterval(() => void load(), waiting ? 3000 : 15_000);
    return () => clearInterval(timer);
  }, [load, waiting]);

  const act = async (id: string, what: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await what();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="messengers">
      <div className="form-actions">
        <h3>Мессенджеры</h3>
        <button className="primary" onClick={() => setAdding(true)}>
          + Добавить
        </button>
      </div>
      <p className="muted">
        Свой номер компании в мессенджере — чтобы написать клиенту первым, когда открытая линия Битрикс24 этого не позволяет. Позже номер
        сопоставляется с открытой линией.
      </p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {items === null && !error && <p className="muted">Загрузка…</p>}
      {items?.length === 0 && <p className="muted">Мессенджеров пока нет. Нажмите «Добавить».</p>}
      <ul className="messenger-list">
        {items?.map((m) => (
          <li key={m.id} className={`messenger-item state-${m.state}`}>
            <div className="messenger-head">
              <span className="messenger-kind">{KIND_ICONS[m.kind]} {label(m.kind)}</span>
              <b>{fmtPhone(m.phone)}</b>
              {m.title && <span className="muted">{m.title}</span>}
              <span className="messenger-state">{MESSENGER_STATE_LABELS[m.state]}</span>
            </div>
            <MessengerLogin m={m} />
            {m.state === 'ready' && m.connectedAt && <p className="muted">Подключён {fmtDateTime(m.connectedAt, timezone)}</p>}
            {m.error && m.state !== 'ready' && <p className="muted">Подробности: {m.error}</p>}
            <p className="muted">
              Открытая линия: {m.line ? `своя «${m.line.name ?? `#${m.line.lineId}`}» — сообщения идут через неё` : 'не привязан — номер работает только в приложении'}
            </p>
            <MessengerGroups m={m} groups={groups} onSaved={() => void load()} />
            <div className="form-actions">
              <button type="button" onClick={() => setChatsOf(m)}>
                💬 Чаты
              </button>
              <button type="button" onClick={() => setLinkOf(m)}>
                🔗 {m.line ? 'Открытая линия' : 'Сопоставить'}
              </button>
              <button type="button" onClick={() => setScreen(m.id)} disabled={m.state === 'unavailable' || m.state === 'stopped'}>
                🖥 Экран
              </button>
              <button type="button" disabled={busy === m.id} onClick={() => void act(m.id, () => apiPost(`/admin/messengers/${m.id}/restart`, {}))}>
                ↻ Перезапустить
              </button>
              {m.state !== 'ready' && m.kind !== 'telegram' && (
                <button type="button" disabled={busy === m.id} onClick={() => void act(m.id, () => apiPost(`/admin/messengers/${m.id}/restart`, { auth: m.auth === 'code' ? 'qr' : 'code' }))}>
                  {m.auth === 'code' ? 'Войти по QR-коду' : 'Войти по коду'}
                </button>
              )}
              {m.state !== 'stopped' && (
                <button type="button" disabled={busy === m.id} onClick={() => void act(m.id, () => apiPost(`/admin/messengers/${m.id}/stop`, {}))}>
                  Остановить
                </button>
              )}
              <button
                type="button"
                className="danger"
                disabled={busy === m.id}
                onClick={() => {
                  if (confirm(`Удалить ${label(m.kind)} ${fmtPhone(m.phone)}? Приложение выйдет из аккаунта, в телефоне исчезнет связанное устройство.`))
                    void act(m.id, () => apiDelete(`/admin/messengers/${m.id}`));
                }}
              >
                Удалить
              </button>
            </div>
          </li>
        ))}
      </ul>
      {adding && (
        <AddMessengerWizard
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      {screen && <MessengerScreen id={screen} onClose={() => setScreen(null)} />}
      {chatsOf && <MessengerChatsDialog messenger={chatsOf} timezone={timezone} onClose={() => setChatsOf(null)} />}
      {linkOf && (
        <MessengerLinkDialog
          messenger={linkOf}
          onClose={() => setLinkOf(null)}
          onSaved={() => {
            setLinkOf(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

/** Подсказка, как войти: код по номеру или QR (виден на экране браузера). */
function MessengerLogin({ m }: { m: MessengerDto }) {
  if (m.state === 'pairing' && m.code)
    return (
      <div className="messenger-login">
        <p>В телефоне с номером {fmtPhone(m.phone)}: WhatsApp → ⋮ / Настройки → «Связанные устройства» → «Привязка устройства» → «Связать по номеру телефона» — и введите код:</p>
        <p className="messenger-code" aria-label="Код для входа">{m.code.replace(/^(.{4})(.{4})$/, '$1-$2')}</p>
      </div>
    );
  if (m.state === 'qr' && m.kind === 'telegram')
    return (
      <p className="messenger-login">
        Откройте «🖥 Экран» и отсканируйте QR-код в телефоне: Telegram → «Настройки» → «Устройства» → «Подключить устройство». Или нажмите на
        экране «Вход по номеру телефона» и введите код из Telegram (и облачный пароль, если он включён).
      </p>
    );
  if (m.state === 'qr')
    return <p className="messenger-login">Откройте «🖥 Экран» и отсканируйте QR-код в телефоне: WhatsApp → «Связанные устройства» → «Привязка устройства».</p>;
  if (m.state === 'logged_out')
    return (
      <p className="messenger-login">
        {m.kind === 'telegram' ? 'Сеанс завершён в Telegram — откройте «🖥 Экран» и войдите заново.' : 'Вход отозван в телефоне — нажмите «Перезапустить», чтобы войти заново.'}
      </p>
    );
  return null;
}

/** Мастер: мессенджер → номер и способ входа → создать (браузер запускается, появляется код). */
function AddMessengerWizard({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<MessengerKind | null>(null);
  const [phone, setPhone] = useState('');
  const [title, setTitle] = useState('');
  const [auth, setAuth] = useState<MessengerAuthMode>('code');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const normalized = normalizeMessengerPhone(phone);

  const create = async () => {
    if (!kind || !normalized) return;
    setSaving(true);
    setError('');
    try {
      await apiPost<MessengerDto>('/admin/messengers', { kind, phone: normalized, auth: kind === 'telegram' ? 'qr' : auth, title: title.trim() || undefined });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось добавить');
      setSaving(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet messenger-wizard" role="dialog" aria-modal="true" aria-labelledby="mw-title" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 id="mw-title">{kind ? `${label(kind)}: номер телефона` : 'Какой мессенджер подключить?'}</h2>
          <button type="button" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </header>
        {!kind ? (
          <div className="messenger-kinds">
            {MESSENGER_KINDS.map((k) => (
              <button key={k.kind} type="button" className="messenger-kind-card" disabled={!k.available} onClick={() => setKind(k.kind)}>
                <span className="messenger-kind-icon">{KIND_ICONS[k.kind]}</span>
                <b>{k.label}</b>
                {!k.available && <span className="muted">скоро</span>}
              </button>
            ))}
          </div>
        ) : (
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label>
              Номер телефона
              <input type="tel" autoFocus placeholder="+7 999 123-45-67" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            {phone && !normalized && <p className="muted">10–15 цифр с кодом страны</p>}
            <label>
              Название (необязательно)
              <input value={title} maxLength={255} placeholder="Например, «Ресепшн»" onChange={(e) => setTitle(e.target.value)} />
            </label>
            {kind === 'telegram' ? (
              <p className="muted">
                Приложение запустит браузер с Telegram Web для этого номера. Вход — на экране браузера («🖥 Экран»): QR-код или номер и код из
                Telegram. Номера, скрытые настройками приватности, приложение находит через контакты аккаунта — они появятся в его контактах.
                Пишите только своим клиентам: за массовые рассылки Telegram ограничивает аккаунт.
              </p>
            ) : (
            <>
            <fieldset>
              <legend>Как войти</legend>
              <label>
                <input type="radio" checked={auth === 'code'} onChange={() => setAuth('code')} /> Код по номеру — ввести 8 символов в телефоне
              </label>
              <label>
                <input type="radio" checked={auth === 'qr'} onChange={() => setAuth('qr')} /> QR-код — отсканировать с экрана браузера
              </label>
            </fieldset>
            <p className="muted">
              Приложение запустит браузер с WhatsApp Web для этого номера. Это неофициальный способ подключения: WhatsApp может ограничить
              номер за массовые рассылки — пишите только своим клиентам.
            </p>
            </>
            )}
            {error && <div className="notice error" role="alert">{error}</div>}
            <div className="form-actions">
              <button type="button" onClick={() => setKind(null)} disabled={saving}>
                ‹ Назад
              </button>
              <button className="primary" disabled={!normalized || saving}>
                {saving ? 'Создаём…' : 'Создать и войти'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Группы номера: сотрудники этих групп видят номер в приложении («Чаты» → «Мессенджеры»): с правом
 * «Читать открытые линии» — читают, «Отвечать» — пишут. Разграничение по чатам — только у номера,
 * привязанного к открытой линии (права линии Битрикс24).
 */
function MessengerGroups({ m, groups, onSaved }: { m: MessengerDto; groups: GroupDto[]; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const toggle = async (id: string) => {
    setBusy(true);
    const next = m.groupIds.includes(id) ? m.groupIds.filter((g) => g !== id) : [...m.groupIds, id];
    await apiPut(`/admin/messengers/${m.id}/groups`, { groupIds: next }).catch(() => undefined);
    setBusy(false);
    onSaved();
  };
  if (!groups.length) return null;
  return (
    <fieldset className="messenger-groups" disabled={busy}>
      <legend>Группы{m.line ? ' (чаты — по правам открытой линии)' : ''}</legend>
      {groups.map((g) => (
        <label key={g.id}>
          <input type="checkbox" checked={m.groupIds.includes(g.id)} onChange={() => void toggle(g.id)} /> {g.name}
        </label>
      ))}
      {!m.groupIds.length && <span className="muted">не выбраны — номер видят только администраторы</span>}
    </fieldset>
  );
}
