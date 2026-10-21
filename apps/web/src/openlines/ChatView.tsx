import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatHistoryDto, ChatMessageDto, MessageTemplateDto, SendResultDto } from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { openCrm, openMessenger } from '../b24.js';
import { fmtDateTime, fmtDayTitle, fmtTime } from '../format.js';
import { appendTemplate, dropSent, isEmpty, newStep, toSteps, type ChainStep } from './chain.js';
import { avatarTone, dayKey, initials } from './chat-list.js';
import { Channel } from './Channel.js';
import { fileSize } from './format.js';
import { Icon } from './icons.js';
import { StepsEditor } from './StepsEditor.js';
import { TemplatesManager } from './TemplatesManager.js';

/** Новые сообщения открытого чата подтягиваем раз в 15 секунд. */
const POLL_MS = 15_000;

/** Открытый диалог: история, «Присоединиться», цепочка сообщений с шаблонами. */
export function ChatView({
  chatId,
  timezone,
  templates,
  onTemplates,
  onBack,
  onChanged,
  bookings,
}: {
  chatId: number;
  timezone: string;
  templates: MessageTemplateDto[] | null;
  onTemplates: (t: MessageTemplateDto[]) => void;
  onBack: () => void;
  /** Что-то отправили/присоединились — список чатов стоит обновить. */
  onChanged: () => void;
  /** Брони клиента и «Создать бронирование» (рендерит страница чатов — у неё группы). */
  bookings?: ReactNode;
}) {
  const [chat, setChat] = useState<ChatHistoryDto | null>(null);
  const [error, setError] = useState('');
  // Ошибка обновления ленты отдельно: фоновое обновление не должно стирать ошибку отправки.
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState<ChainStep[]>(() => [newStep()]);
  const [templatesOpen, setTemplatesOpen] = useState<'list' | 'save' | null>(null);
  const [templatePick, setTemplatePick] = useState('');
  const list = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await apiGet<ChatHistoryDto>(`/openlines/chats/${chatId}/messages`);
      setChat((prev) => {
        // Подгруженные ранее старые сообщения сохраняем.
        if (!prev || prev.chatId !== chatId) return fresh;
        const ids = new Set(fresh.messages.map((m) => m.id));
        return {
          ...fresh,
          hasMore: prev.hasMore,
          messages: [...prev.messages.filter((m) => !ids.has(m.id)), ...fresh.messages],
        };
      });
      setLoadError('');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить чат');
    }
  }, [chatId]);

  useEffect(() => {
    let active = true;
    void apiGet<ChatHistoryDto>(`/openlines/chats/${chatId}/messages`).then(
      (c) => active && setChat(c),
      (e) => active && setLoadError(e instanceof Error ? e.message : 'Не удалось загрузить чат'),
    );
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [chatId, load]);

  const lastId = chat?.messages[chat.messages.length - 1]?.id;
  // Новое сообщение — прокрутить ленту вниз (внутри ленты, не всю страницу фрейма).
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [lastId]);

  const older = async () => {
    if (!chat?.messages.length) return;
    const page = await apiGet<ChatHistoryDto>(`/openlines/chats/${chatId}/messages?beforeId=${chat.messages[0].id}`);
    setChat({ ...chat, hasMore: page.hasMore, messages: [...page.messages, ...chat.messages] });
  };

  const join = async () => {
    setBusy(true);
    setError('');
    try {
      await apiPost(`/openlines/chats/${chatId}/join`);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось присоединиться');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const steps = toSteps(chain);
    if (!steps.length || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await apiPost<SendResultDto>(`/openlines/chats/${chatId}/send`, { steps });
      setChain(dropSent(chain, res.sent));
      if (res.error)
        setError(
          `${res.sent ? `Отправлено ${res.sent} из ${steps.length}. ` : ''}Сообщение ${res.error.step + 1} не ушло: ${res.error.message}`,
        );
      else setNotice(steps.length > 1 ? `Отправлено сообщений: ${res.sent}` : '');
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить');
    } finally {
      setBusy(false);
    }
  };

  if (!chat)
    return (
      <main className="chat-view">
        <ChatHeader chatId={chatId} title="Чат" onBack={onBack} />
        {loadError ? (
          <div className="notice error" role="alert">
            {loadError}
          </div>
        ) : (
          <p className="muted pad">Загрузка сообщений…</p>
        )}
      </main>
    );

  const crm = chat.crm;
  const links: [string, 'deal' | 'contact' | 'lead', number | null][] = [
    ['Сделка', 'deal', crm.dealId],
    ['Контакт', 'contact', crm.contactId],
    ['Лид', 'lead', crm.leadId],
  ];
  return (
    <main className="chat-view">
      <ChatHeader
        chatId={chat.chatId}
        title={chat.title}
        subtitle={<Channel connector={chat.connector} />}
        onBack={onBack}
        tags={links
          .filter(([, , id]) => id)
          .map(([label, type, id]) => (
            <button key={type} className="cv-tag" onClick={() => openCrm(type, id!)}>
              {label} #{id}
            </button>
          ))}
      >
        <button className="cv-crm-btn" onClick={() => openMessenger(chat.chatId)} title="Открыть диалог в мессенджере Битрикс24">
          В Битрикс24 <Icon name="external" size={16} />
        </button>
      </ChatHeader>

      {bookings}

      <div className="cv-conversation" ref={list} aria-live="polite" aria-label="История сообщений">
        {chat.hasMore && (
          <button className="link older" onClick={() => void older()}>
            Показать более ранние
          </button>
        )}
        {chat.messages.map((m, i) => {
          const day = dayKey(m.date, timezone);
          const newDay = i === 0 || dayKey(chat.messages[i - 1].date, timezone) !== day;
          return (
            <Fragment key={m.id}>
              {newDay && <div className="cv-date">{fmtDayTitle(day, timezone)}</div>}
              <Message m={m} chatId={chat.chatId} title={chat.title} timezone={timezone} />
            </Fragment>
          );
        })}
      </div>

      {(error || loadError) && (
        <div className="notice error" role="alert">
          {error || loadError}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      {!chat.joined ? (
        <div className="chat-join">
          <span className="muted">Вы не участник этого диалога.</span>
          <button className="primary" disabled={busy} onClick={() => void join()}>
            Присоединиться к чату
          </button>
        </div>
      ) : !chat.canSend ? (
        <p className="muted pad">Нет права отправлять сообщения в открытые линии (настраивается в группе).</p>
      ) : (
        <div className="composer cv-composer">
          <div className="composer-tools">
            <select
              aria-label="Шаблон"
              value={templatePick}
              disabled={busy || !templates?.length}
              onChange={(e) => {
                const t = templates?.find((x) => x.id === e.target.value);
                if (t) setChain(appendTemplate(chain, t));
                setTemplatePick('');
              }}
            >
              <option value="">{templates?.length ? 'Вставить шаблон…' : 'Шаблонов нет'}</option>
              {templates?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.steps.length})
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setTemplatesOpen('list')}>
              Мои шаблоны
            </button>
            <button type="button" disabled={chain.every(isEmpty)} onClick={() => setTemplatesOpen('save')}>
              Сохранить как шаблон
            </button>
          </div>
          <StepsEditor steps={chain} onChange={setChain} disabled={busy} onSubmitShortcut={() => void send()} />
          <div className="form-actions">
            <button className="primary" disabled={busy || chain.every(isEmpty)} onClick={() => void send()}>
              {busy
                ? 'Отправка…'
                : toSteps(chain).length > 1
                  ? `Отправить цепочку (${toSteps(chain).length})`
                  : 'Отправить'}
            </button>
            <span className="muted hint-desktop">Ctrl+Enter — отправить</span>
          </div>
        </div>
      )}

      {templatesOpen && templates && (
        <TemplatesManager
          templates={templates}
          initial={
            templatesOpen === 'save' ? chain.filter((s) => !isEmpty(s)).map((s) => newStep(s.text, s.files)) : undefined
          }
          onChanged={onTemplates}
          onClose={() => setTemplatesOpen(null)}
        />
      )}
    </main>
  );
}

function ChatHeader({
  chatId,
  title,
  subtitle,
  tags,
  onBack,
  children,
}: {
  chatId: number;
  title: string;
  subtitle?: ReactNode;
  tags?: ReactNode[];
  onBack: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="cv-head">
      <div className="cv-contact-line">
        <button className="cl-btn chat-back" aria-label="К списку чатов" title="К чатам" onClick={onBack}>
          <Icon name="back" />
        </button>
        <span className={`avatar large a${avatarTone(chatId)}`}>{initials(title)}</span>
        <div className="cv-contact-info">
          <div className="cv-contact-name">{title}</div>
          {subtitle && <div className="cv-contact-sub">{subtitle}</div>}
        </div>
        <div className="cv-actions">{children}</div>
      </div>
      {tags && tags.length > 0 && <div className="cv-tags">{tags}</div>}
    </header>
  );
}

function Message({ m, chatId, title, timezone }: { m: ChatMessageDto; chatId: number; title: string; timezone: string }) {
  if (m.author.kind === 'system')
    return (
      <div className="cv-system">
        {m.text} <span className="muted">{fmtTime(m.date, timezone)}</span>
      </div>
    );
  const incoming = m.author.kind === 'client';
  return (
    <div className={`cv-row${incoming ? '' : ' out'}`}>
      {incoming && <span className={`cv-msg-avatar a${avatarTone(chatId)}`}>{initials(m.author.name || title)}</span>}
      <div className="cv-bubble">
        <div className="cv-bubble-meta">
          <strong>{m.author.name}</strong>
          <time dateTime={m.date} title={fmtDateTime(m.date, timezone)}>
            {fmtTime(m.date, timezone)}
          </time>
        </div>
        {m.text && <div className="cv-bubble-text">{m.text}</div>}
        {m.files.map((f) => (
          <a key={f.id} className="msg-file" href={f.url ?? undefined} target="_blank" rel="noreferrer">
            {f.type === 'image' && f.previewUrl ? <img src={f.previewUrl} alt={f.name} loading="lazy" /> : <Icon name="clip" size={14} />}{' '}
            {f.name} <span className="muted">{fileSize(f.size)}</span>
          </a>
        ))}
      </div>
      {!incoming && <span className="cv-msg-avatar agent">{initials(m.author.name || 'Оператор')}</span>}
    </div>
  );
}
