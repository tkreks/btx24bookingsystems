import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatChannelDto, ChatHistoryDto, ChatMessageDto, ChatReplyStatusDto, ChatSummary, MessageTemplateDto, SendResultDto } from '@btx24/shared';
import { apiGet, apiPost, apiPut } from '../api.js';
import { openCrm, openMessenger } from '../b24.js';
import { fmtDateTime, fmtDayTitle, fmtTime } from '../format.js';
import { appendTemplate, dropSent, isEmpty, newStep, toSteps, type ChainStep } from './chain.js';
import { avatarTone, dayKey, initials } from './chat-list.js';
import { Channel } from './Channel.js';
import { Icon } from './icons.js';
import { StepsEditor } from './StepsEditor.js';
import { TemplatesManager } from './TemplatesManager.js';
import { InvoicesBadge } from '../bookings/InvoicesBadge.js';
import { ChatFile } from './ChatFile.js';

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
  onPayment,
  paymentRevision = 0,
  bookings,
  status,
  onStatus,
  onOpenChat,
}: {
  chatId: number;
  timezone: string;
  templates: MessageTemplateDto[] | null;
  onTemplates: (t: MessageTemplateDto[]) => void;
  onBack: () => void;
  /** Что-то отправили/присоединились — список чатов стоит обновить. */
  onChanged: () => void;
  /** Счёт и ссылка на оплату по сделке чата (есть право `payment.send`). */
  onPayment?: (dealId: number) => void;
  /** Сменился — значок счетов перечитывается (окно счетов закрыли). */
  paymentRevision?: number;
  /** Брони клиента и «Создать бронирование» (рендерит страница чатов — у неё группы). */
  bookings?: ReactNode;
  /** Статус из списка чатов: ждёт ответа / «Не требует ответа» (общий для всех). */
  status?: Pick<ChatSummary, 'waitingReply' | 'noReply' | 'sessionClosed'>;
  onStatus?: (r: ChatReplyStatusDto) => void;
  /** Открыть другой чат (канал того же клиента). */
  onOpenChat?: (chatId: number) => void;
}) {
  const [chat, setChat] = useState<ChatHistoryDto | null>(null);
  const [error, setError] = useState('');
  // Ошибка обновления ленты отдельно: фоновое обновление не должно стирать ошибку отправки.
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Отправка — отдельно от прочих действий: блок сообщения закрывается загрузчиком.
  const [sending, setSending] = useState(false);
  const [channels, setChannels] = useState<ChatChannelDto[]>([]);
  const [marking, setMarking] = useState(false);

  // Каналы клиента: у контакта может быть несколько открытых линий — у каждой свой чат.
  useEffect(() => {
    let active = true;
    apiGet<ChatChannelDto[]>(`/openlines/chats/${chatId}/channels`).then(
      (c) => active && setChannels(c),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [chatId]);

  const setReply = async (needed: boolean) => {
    setMarking(true);
    setError('');
    try {
      onStatus?.(await apiPut<ChatReplyStatusDto>(`/openlines/chats/${chatId}/reply-status`, { needed }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось изменить статус');
    } finally {
      setMarking(false);
    }
  };
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

  // Шаблон с переменными — сразу подставляем данные сделки чата: сотрудник видит готовый текст.
  const insertTemplate = async (t: MessageTemplateDto) => {
    try {
      const r = await apiPost<{ texts: string[]; unresolved: string[] }>(`/openlines/chats/${chatId}/render`, { texts: t.steps.map((s) => s.text) });
      setChain(appendTemplate(chain, { ...t, steps: t.steps.map((s, i) => ({ ...s, text: r.texts[i] ?? s.text })) }));
      setNotice(r.unresolved.length ? `Не подставлено: ${r.unresolved.join(', ')} — проверьте текст перед отправкой` : '');
    } catch {
      setChain(appendTemplate(chain, t));
    }
  };

  const send = async () => {
    const steps = toSteps(chain);
    if (!steps.length || busy) return;
    setBusy(true);
    setSending(true);
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
      setSending(false);
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
  return (
    <main className="chat-view">
      <ChatHeader
        chatId={chat.chatId}
        title={chat.title}
        subtitle={
          <>
            {channels.length > 1 && onOpenChat ? (
              <span className="cv-channels" role="group" aria-label="Мессенджер клиента">
                {channels.map((c) => (
                  <button
                    key={c.chatId}
                    type="button"
                    className={`cv-channel${c.chatId === chat.chatId ? ' active' : ''}`}
                    aria-pressed={c.chatId === chat.chatId}
                    title={c.waitingReply ? 'Ждёт ответа' : undefined}
                    onClick={() => c.chatId !== chat.chatId && onOpenChat(c.chatId)}
                  >
                    <Channel connector={c.connector} />
                    {c.waitingReply && <i className="cv-channel-dot" aria-label="ждёт ответа" />}
                  </button>
                ))}
              </span>
            ) : (
              <Channel connector={chat.connector} />
            )}
            {crm.dealId && (
              <>
                <span className="cv-sep">|</span>
                <button className="link cv-deal" onClick={() => openCrm('deal', crm.dealId!)}>
                  Сделка #{crm.dealId}
                </button>
                {onPayment && <InvoicesBadge dealId={crm.dealId} revision={paymentRevision} onOpen={() => onPayment(crm.dealId!)} />}
              </>
            )}
          </>
        }
        onBack={onBack}
        details={bookings}
      >
        {status && !status.sessionClosed && onStatus && (status.waitingReply || status.noReply) && (
          <span className="cv-reply">
            {status.noReply ? (
              <>
                <span className="cl-status noreply" title={status.noReply.byName ? `Отметил: ${status.noReply.byName}` : undefined}>
                  Не требует ответа
                </span>
                <button type="button" className="cl-btn" disabled={marking} onClick={() => void setReply(true)}>
                  Ждёт ответа
                </button>
              </>
            ) : (
              <button type="button" className="cl-btn" disabled={marking} onClick={() => void setReply(false)} title="Отметка видна всем сотрудникам">
                Не требует ответа
              </button>
            )}
          </span>
        )}
        <button
          className="cl-btn cv-open"
          onClick={() => openMessenger(chat.chatId)}
          title="Открыть диалог в Битрикс24"
          aria-label="Открыть диалог в Битрикс24"
        >
          <Icon name="external" size={15} />
        </button>
      </ChatHeader>

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
        <div className={`composer cv-composer${sending ? ' sending' : ''}`} aria-busy={sending}>
          {sending && (
            <div className="cv-sending" role="status">
              <span className="spinner" aria-hidden="true" />
              Отправляем сообщение, ожидайте…
            </div>
          )}
          <div className="composer-tools">
            <select
              aria-label="Шаблон"
              value={templatePick}
              disabled={busy || !templates?.length}
              onChange={(e) => {
                const t = templates?.find((x) => x.id === e.target.value);
                setTemplatePick('');
                if (t) void insertTemplate(t);
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
  details,
  onBack,
  children,
}: {
  chatId: number;
  title: string;
  subtitle?: ReactNode;
  /** Под каналом: клиент, его статистика и брони. */
  details?: ReactNode;
  onBack: () => void;
  /** Маленькие кнопки в правом верхнем углу. */
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
          {details}
        </div>
        <div className="cv-actions">{children}</div>
      </div>
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
          {m.viaPhone && (
            <span className="via-phone" title="Отправлено менеджером с телефона из рабочего WhatsApp (Wazzup)">
              📱 с телефона
            </span>
          )}
          <time dateTime={m.date} title={fmtDateTime(m.date, timezone)}>
            {fmtTime(m.date, timezone)}
          </time>
        </div>
        {m.text && <div className="cv-bubble-text">{m.text}</div>}
        {m.files.map((f) => (
          <ChatFile key={f.id} chatId={chatId} f={f} />
        ))}
      </div>
      {!incoming && <span className="cv-msg-avatar agent">{initials(m.author.name || 'Оператор')}</span>}
    </div>
  );
}
