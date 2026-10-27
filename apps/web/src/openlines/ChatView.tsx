import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatChannelDto, ChatHistoryDto, ChatMessageDto, ChatReplyStatusDto, ChatSummary, MessageTemplateDto, SendResultDto } from '@btx24/shared';
import { apiGet, apiPost, apiPut } from '../api.js';
import { pollEvery } from '../fresh-poll.js';
import { openCrm, openMessenger } from '../b24.js';
import { fmtDateTime, fmtDayTitle, fmtTime } from '../format.js';
import { appendTemplate, isEmpty, newStep, toSteps, type ChainStep } from './chain.js';
import { avatarTone, dayKey, initials } from './chat-list.js';
import { ChatDealCard } from './ChatDealCard.js';
import { Avatar } from './Avatar.js';
import { ChannelSwitch } from './ChannelSwitch.js';
import { clipName, connectorLabel } from './format.js';
import { Icon } from './icons.js';
import { StepsEditor } from './StepsEditor.js';
import { TemplatesManager } from './TemplatesManager.js';
import { TemplatesPicker } from './TemplatesPicker.js';
import { InvoicesBadge } from '../bookings/InvoicesBadge.js';
import { ChatFile } from './ChatFile.js';
import { ChannelRecovery } from './ChannelRecovery.js';
import { hasDisabledWazzupChannel } from './channel-error.js';
import { Reactions } from '../messengers/Reactions.js';
import { LoadProgress } from '../dashboard/LoadProgress.js';

/** Новые сообщения открытого чата подтягиваем раз в 15 секунд. */
const POLL_MS = 15_000;
/** Лента пришла из базы, а сверка с Битрикс24 идёт в фоне — перечитать вскоре, не ждать опроса. */
const SYNC_RELOAD_MS = 2_500;

/**
 * Отправленное сообщение до появления в ленте (2026-10-27): показывается сразу, с песочными часами;
 * ушло — ✓ (исчезнет, когда придёт из Битрикс24 со статусом доставки); ошибка — красным, «?» с текстом.
 */
export interface Outgoing {
  key: string;
  text: string;
  files: string[];
  date: string;
  status: 'sending' | 'sent' | 'error';
  error?: string;
  /** ID сообщений Битрикс24 (текст и каждый файл — отдельным сообщением). */
  ids: number[];
  step: ReturnType<typeof toSteps>[number];
}

/** Результат отправки цепочки → статусы её сообщений в «исходящих». */
export function applySendResult(items: Outgoing[], res: SendResultDto): Outgoing[] {
  let at = 0;
  return items.map((o, i) => {
    const count = (o.step.text.trim() ? 1 : 0) + o.step.fileIds.length;
    const ids = res.messageIds.slice(at, at + count);
    at += count;
    if (i < res.sent) return { ...o, status: 'sent', ids };
    if (res.error && i === res.error.step) return { ...o, status: 'error', error: res.error.message, ids };
    return { ...o, status: 'error', error: 'Не отправлено: предыдущее сообщение цепочки не ушло', ids };
  });
}

/** Ушедшие сообщения, которые уже пришли в ленте, из «исходящих» убираем. */
export function pendingOutgoing(items: Outgoing[], messages: { id: number }[]): Outgoing[] {
  const shown = new Set(messages.map((m) => m.id));
  return items.filter((o) => o.status !== 'sent' || !o.ids.length || !o.ids.every((id) => shown.has(id)));
}

/** Открытый диалог: история, «Присоединиться», цепочка сообщений с шаблонами. */
export function ChatView({
  chatId,
  timezone,
  templates,
  onTemplates,
  onBack,
  onRefresh,
  onChanged,
  onPayment,
  paymentRevision = 0,
  bookings,
  status,
  onStatus,
  onOpenChat,
  templatesRequest = 0,
}: {
  /** Сменился (больше 0) — открыть окно «Шаблоны» (быстрое действие во встройке сделки). */
  templatesRequest?: number;
  chatId: number;
  timezone: string;
  templates: MessageTemplateDto[] | null;
  onTemplates: (t: MessageTemplateDto[]) => void;
  /** Нет — кнопки «назад» нет (встройка сделки, чат клиента один). */
  onBack?: () => void;
  /** Кнопка «обновить» рядом с «назад» (встройка сделки): перечитать чат и список. */
  onRefresh?: () => void;
  /** Что-то отправили/присоединились — список чатов стоит обновить. */
  onChanged: () => void;
  /** Счёт и ссылка на оплату по сделке чата (есть право `payment.send`). */
  onPayment?: (dealId: number) => void;
  /** Сменился — значок счетов перечитывается (окно счетов закрыли). */
  paymentRevision?: number;
  /** Брони клиента и «Создать бронирование» (рендерит страница чатов — у неё группы). */
  bookings?: ReactNode;
  /** Статус из списка чатов: ждёт ответа / «Не требует ответа» (общий для всех). */
  status?: Pick<ChatSummary, 'waitingReply' | 'noReply' | 'sessionClosed' | 'clientName'> & Partial<Pick<ChatSummary, 'phones' | 'lastMessage' | 'clientAvatar'>>;
  onStatus?: (r: ChatReplyStatusDto) => void;
  /** Открыть другой чат (канал того же клиента). */
  onOpenChat?: (chatId: number) => void;
}) {
  const [chat, setChat] = useState<ChatHistoryDto | null>(null);
  const [error, setError] = useState('');
  // Ошибка обновления ленты отдельно: фоновое обновление не должно стирать ошибку отправки.
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Отправленные, но ещё не пришедшие в ленте сообщения; поле ввода не блокируется.
  const [outbox, setOutbox] = useState<Outgoing[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  // Шаблон загружается (подстановка данных сделки) — поле ввода заблокировано, как при отправке.
  const [templating, setTemplating] = useState<string | null>(null);
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

  // Переписка (ADR 0017): лента собрана из нескольких чатов, действия — в чат, куда пишем.
  const target = chat?.sendChatId ?? chatId;
  const setReply = async (needed: boolean) => {
    setMarking(true);
    setError('');
    try {
      onStatus?.(await apiPut<ChatReplyStatusDto>(`/openlines/chats/${target}/reply-status`, { needed }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось изменить статус');
    } finally {
      setMarking(false);
    }
  };
  const [chain, setChain] = useState<ChainStep[]>(() => [newStep()]);
  // Окно «Шаблоны» (выбор по частоте); управление и новый шаблон — в TemplatesManager.
  const [templatesOpen, setTemplatesOpen] = useState<'pick' | 'list' | 'new' | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // Запрос «Шаблоны» снаружи — открыть окно выбора, как кнопкой под «Отправить».
  const [seenRequest, setSeenRequest] = useState(templatesRequest);
  if (templatesRequest !== seenRequest) {
    setSeenRequest(templatesRequest);
    if (templatesRequest > 0) setTemplatesOpen('pick');
  }

  // `sync` — сверить с Битрикс24 до ответа (после своих действий); обычно лента — из базы, сверка в фоне.
  const load = useCallback(async (sync = false) => {
    try {
      const fresh = await apiGet<ChatHistoryDto>(`/openlines/chats/${chatId}/messages${sync ? '?fresh=1' : ''}`);
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
    const stop = pollEvery(() => load(), POLL_MS);
    return () => {
      active = false;
      stop();
    };
  }, [chatId, load]);

  // Пришли в ленте — убрать из «исходящих».
  const messages = chat?.messages;
  useEffect(() => {
    if (messages) setOutbox((prev) => (prev.length ? pendingOutgoing(prev, messages) : prev));
  }, [messages]);
  // Сверка с Битрикс24 идёт в фоне — перечитать вскоре (новые сообщения не ждут опроса).
  const syncing = !!chat?.syncing;
  useEffect(() => {
    if (!syncing) return;
    const t = setTimeout(() => void load(), SYNC_RELOAD_MS);
    return () => clearTimeout(t);
  }, [syncing, chat, load]);

  const lastId = chat?.messages[chat.messages.length - 1]?.id;
  // Новое сообщение — прокрутить ленту вниз (внутри ленты, не всю страницу фрейма).
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [lastId, outbox.length]);

  const older = async () => {
    if (!chat?.messages.length) return;
    const page = await apiGet<ChatHistoryDto>(`/openlines/chats/${chatId}/messages?beforeId=${chat.messages[0].id}`);
    setChat({ ...chat, hasMore: page.hasMore, messages: [...page.messages, ...chat.messages] });
  };

  const join = async () => {
    setBusy(true);
    setError('');
    try {
      await apiPost(`/openlines/chats/${target}/join`);
      await load(true);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось присоединиться');
    } finally {
      setBusy(false);
    }
  };

  // Шаблон с переменными — сразу подставляем данные сделки чата: сотрудник видит готовый текст.
  const insertTemplate = async (t: MessageTemplateDto) => {
    // Частота для сортировки окна «Шаблоны»; сбой учёта вставку не мешает.
    void apiPost(`/openlines/templates/${t.id}/use`).then(
      () => templates && onTemplates(templates.map((x) => (x.id === t.id ? { ...x, uses30d: (x.uses30d ?? 0) + 1 } : x))),
      () => undefined,
    );
    setTemplating(t.name || 'шаблон');
    try {
      const r = await apiPost<{ texts: string[]; unresolved: string[] }>(`/openlines/chats/${target}/render`, { texts: t.steps.map((s) => s.text) });
      setChain(appendTemplate(chain, { ...t, steps: t.steps.map((s, i) => ({ ...s, text: r.texts[i] ?? s.text })) }));
      setNotice(r.unresolved.length ? `Не подставлено: ${r.unresolved.join(', ')} — проверьте текст перед отправкой` : '');
    } catch {
      setChain(appendTemplate(chain, t));
    } finally {
      setTemplating(null);
    }
  };

  /** Отправка по очереди (порядок у клиента важен); статусы — в «исходящих». */
  const dispatch = (items: Outgoing[]) => {
    const keys = new Set(items.map((o) => o.key));
    const mark = (f: (list: Outgoing[]) => Outgoing[]) => setOutbox((prev) => [...prev.filter((o) => !keys.has(o.key)), ...f(prev.filter((o) => keys.has(o.key)))]);
    queue.current = queue.current.then(async () => {
      try {
        const res = await apiPost<SendResultDto>(`/openlines/chats/${target}/send`, { steps: items.map((o) => o.step) });
        mark((list) => applySendResult(list, res));
        await load(true);
        onChanged();
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Не удалось отправить';
        mark((list) => list.map((o) => ({ ...o, status: 'error', error: message })));
      }
    });
  };

  const send = () => {
    if (uploading || busy) return;
    const steps = toSteps(chain);
    if (!steps.length) return;
    setError('');
    setNotice('');
    const now = new Date().toISOString();
    const items: Outgoing[] = steps.map((step, i) => ({
      key: `${now}:${i}:${Math.random()}`,
      text: step.text,
      files: chain.filter((c) => !isEmpty(c))[i]?.files.map((f) => f.name) ?? [],
      date: now,
      status: 'sending',
      ids: [],
      step,
    }));
    // Сообщение сразу в ленте (⏳), поле ввода свободно для следующего.
    setOutbox((prev) => [...prev, ...items]);
    setChain([newStep()]);
    dispatch(items);
  };

  const retry = (o: Outgoing) => {
    const again = { ...o, status: 'sending' as const, error: undefined, ids: [] };
    setOutbox((prev) => prev.map((x) => (x.key === o.key ? again : x)));
    dispatch([again]);
  };

  if (!chat)
    return (
      <main className="chat-view">
        <ChatHeader chatId={chatId} title="Чат" onBack={onBack} onRefresh={onRefresh} />
        {loadError ? (
          <div className="notice error" role="alert">
            {loadError}
          </div>
        ) : (
          <p className="muted pad"><LoadProgress name="chat-messages" label="Загрузка сообщений" /></p>
        )}
      </main>
    );

  const crm = chat.crm;
  const memberIds = chat.chats?.map((c) => c.chatId) ?? [chat.chatId];
  const currentChannel = channels.find((c) => memberIds.includes(c.chatId))?.chatId ?? chat.chatId;
  const sourceOf = new Map((chat.chats ?? []).map((c) => [c.chatId, c]));
  return (
    <main className="chat-view cv-has-sync">
      <ChatHeader
        chatId={chat.chatId}
        title={status?.clientName || chat.title}
        avatar={status?.clientAvatar}
        onTitle={crm.contactId ? () => openCrm('contact', crm.contactId!) : undefined}
        subtitle={
          <>
            <ChannelSwitch channels={channels} current={currentChannel} connector={chat.connector} timezone={timezone} onOpen={onOpenChat} />
            <ChatDealCard
              chatId={target}
              dealId={crm.dealId}
              appChat={chat.connector.startsWith('btx24_')}
              timezone={timezone}
              extra={crm.dealId && onPayment ? <InvoicesBadge dealId={crm.dealId} revision={paymentRevision} onOpen={() => onPayment(crm.dealId!)} /> : undefined}
            />
          </>
        }
        onBack={onBack}
        onRefresh={onRefresh}
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
          onClick={() => openMessenger(target)}
          title="Открыть диалог в Битрикс24"
          aria-label="Открыть диалог в Битрикс24"
        >
          <Icon name="external" size={15} />
        </button>
      </ChatHeader>

      {(hasDisabledWazzupChannel(chat.connector, status?.lastMessage?.preview) || chat.messages.some(m => hasDisabledWazzupChannel(chat.connector, m.text))) && (
        <ChannelRecovery key={chat.chatId} connector={chat.connector} channels={channels} phones={status?.phones ?? []} timezone={timezone} onOpen={onOpenChat} />
      )}

      {chat.syncing && (
        <p className="cv-syncing" role="status">
          <span className="sync-dot active" aria-hidden="true" /> Синхронизация с Битрикс24…
        </p>
      )}
      <div className="cv-conversation" ref={list} aria-live="polite" aria-label="История сообщений">
        {!!chat.hiddenChats && (
          <div className="cv-system muted">
            Ещё {chat.hiddenChats} {chat.hiddenChats === 1 ? 'диалог' : 'диалога'} с клиентом в этом канале скрыты: нет доступа в Битрикс24
          </div>
        )}
        {chat.hasMore && (
          <button className="link older" onClick={() => void older()}>
            Показать более ранние
          </button>
        )}
        {chat.messages.map((m, i) => {
          const day = dayKey(m.date, timezone);
          const newDay = i === 0 || dayKey(chat.messages[i - 1].date, timezone) !== day;
          // Переписка из нескольких чатов: где сменился чат открытой линии — подпись источника.
          const source = m.chatId ? sourceOf.get(m.chatId) : undefined;
          const newSource = sourceOf.size > 1 && source && (i === 0 || chat.messages[i - 1].chatId !== m.chatId);
          return (
            <Fragment key={m.id}>
              {newDay && <div className="cv-date">{fmtDayTitle(day, timezone)}</div>}
              {newSource && (
                <div className="cv-source" title={source.title}>
                  {connectorLabel(source.connector)} · {source.title}
                </div>
              )}
              <Message m={m} chatId={m.chatId ?? chat.chatId} title={chat.title} timezone={timezone} />
            </Fragment>
          );
        })}
        {outbox.map((o) => (
          <OutgoingMessage key={o.key} o={o} timezone={timezone} onRetry={() => retry(o)} onDrop={() => setOutbox((prev) => prev.filter((x) => x.key !== o.key))} />
        ))}
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
        <div className={`composer cv-composer${templating ? ' sending' : ''}`} aria-busy={!!templating}>
          {templating && (
            <div className="cv-sending" role="status">
              <span className="spinner" aria-hidden="true" />
              Загружаем шаблон «{templating}» — подставляем данные клиента…
            </div>
          )}
          <div className="cv-composer-row">
            <StepsEditor compact onUploadingChange={setUploading} steps={chain} onChange={setChain} disabled={busy || !!templating} onSubmitShortcut={() => void send()} />
            <div className="cv-composer-side">
              <button className="primary" disabled={busy || uploading || !!templating || chain.every(isEmpty)} onClick={() => void send()} title="Ctrl+Enter — отправить">
                {busy
                  ? 'Отправка…'
                  : toSteps(chain).length > 1
                    ? `Отправить (${toSteps(chain).length})`
                    : 'Отправить'}
              </button>
              <button type="button" className="cv-templates-btn" disabled={busy || uploading || !!templating || !templates} onClick={() => setTemplatesOpen('pick')}>
                Шаблоны
              </button>
            </div>
          </div>
        </div>
      )}

      {templatesOpen === 'pick' && templates && (
        <TemplatesPicker
          templates={templates}
          onPick={(t) => {
            setTemplatesOpen(null);
            void insertTemplate(t);
          }}
          onCreate={() => setTemplatesOpen('new')}
          onManage={() => setTemplatesOpen('list')}
          onClose={() => setTemplatesOpen(null)}
        />
      )}
      {(templatesOpen === 'list' || templatesOpen === 'new') && templates && (
        <TemplatesManager
          templates={templates}
          initial={templatesOpen === 'new' ? [newStep()] : undefined}
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
  avatar,
  onTitle,
  subtitle,
  details,
  onBack,
  onRefresh,
  children,
}: {
  chatId: number;
  title: string;
  /** Фото клиента из Битрикс24 (у чатов приложения — из мессенджера). */
  avatar?: string | null;
  /** Имя клиента — ссылка на контакт в CRM. */
  onTitle?: () => void;
  subtitle?: ReactNode;
  /** Под каналом: клиент, его статистика и брони. */
  details?: ReactNode;
  onBack?: () => void;
  onRefresh?: () => void;
  /** Маленькие кнопки в правом верхнем углу. */
  children?: ReactNode;
}) {
  return (
    <header className="cv-head">
      <div className="cv-contact-line">
        {onBack && (
          <button className="cl-btn chat-back" aria-label="К списку чатов" title="К чатам" onClick={onBack}>
            <Icon name="back" />
          </button>
        )}
        {onRefresh && (
          <button className="cl-btn chat-refresh" aria-label="Обновить чат" title="Обновить чат" onClick={onRefresh}>
            <Icon name="refresh" />
          </button>
        )}
        <Avatar src={avatar} name={title} size={null} tone={avatarTone(chatId)} className="large" />
        <div className="cv-contact-info">
          {onTitle ? (
            <button type="button" className="cv-contact-name link" title={`${title} — открыть контакт в CRM`} onClick={onTitle}>
              {clipName(title)}
            </button>
          ) : (
            <div className="cv-contact-name" title={title}>
              {clipName(title)}
            </div>
          )}
          {subtitle && <div className="cv-contact-sub">{subtitle}</div>}
          {details}
        </div>
        <div className="cv-actions">{children}</div>
      </div>
    </header>
  );
}

const DELIVERY: Record<'sending' | 'sent' | 'delivered', { mark: string; title: string }> = {
  sending: { mark: '⏳', title: 'Отправляется…' },
  sent: { mark: '✓', title: 'Принято открытой линией Битрикс24' },
  delivered: { mark: '✓✓', title: 'Доставлено в мессенджер клиента' },
};

function DeliveryMark({ status }: { status: keyof typeof DELIVERY }) {
  return (
    <span className={`cv-delivery ${status}`} title={DELIVERY[status].title} aria-label={DELIVERY[status].title}>
      {DELIVERY[status].mark}
    </span>
  );
}

/** Своё сообщение до прихода в ленту: ⏳ / ✓, ошибка — красным, «?» с причиной и «Повторить». */
function OutgoingMessage({ o, timezone, onRetry, onDrop }: { o: Outgoing; timezone: string; onRetry: () => void; onDrop: () => void }) {
  return (
    <div className={`cv-row out cv-outgoing${o.status === 'error' ? ' failed' : ''}`}>
      <div className="cv-bubble">
        <div className="cv-bubble-meta">
          <strong>Вы</strong>
          <time dateTime={o.date} title={fmtDateTime(o.date, timezone)}>
            {fmtTime(o.date, timezone)}
          </time>
          {o.status === 'error' ? (
            <span className="cv-delivery error" tabIndex={0} title={`Не отправлено: ${o.error ?? 'ошибка'}`} aria-label={`Не отправлено: ${o.error ?? 'ошибка'}`}>
              ?
            </span>
          ) : (
            <DeliveryMark status={o.status} />
          )}
        </div>
        {o.text && <div className="cv-bubble-text">{o.text}</div>}
        {o.files.map((f) => (
          <div key={f} className="muted">📎 {f}</div>
        ))}
        {o.status === 'error' && (
          <div className="cv-outgoing-actions">
            <button type="button" className="link" onClick={onRetry}>
              Повторить
            </button>
            <button type="button" className="link" onClick={onDrop}>
              Убрать
            </button>
          </div>
        )}
      </div>
    </div>
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
            <span className="via-phone" title="Отправлено менеджером с телефона, не из Битрикс24 и не из приложения">
              📱 с телефона
            </span>
          )}
          <time dateTime={m.date} title={fmtDateTime(m.date, timezone)}>
            {fmtTime(m.date, timezone)}
          </time>
          {m.delivery && <DeliveryMark status={m.delivery} />}
        </div>
        {m.text && <div className="cv-bubble-text">{m.text}</div>}
        {m.files.map((f) => (
          <ChatFile key={f.id} chatId={chatId} f={f} />
        ))}
        <Reactions items={m.reactions} />
      </div>
      {!incoming && <span className="cv-msg-avatar agent">{initials(m.author.name || 'Оператор')}</span>}
    </div>
  );
}
