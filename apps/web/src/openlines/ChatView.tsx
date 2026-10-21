import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatHistoryDto, ChatMessageDto, MessageTemplateDto, SendResultDto } from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { openCrm, openMessenger } from '../b24.js';
import { fmtDateTime } from '../format.js';
import { appendTemplate, dropSent, isEmpty, newStep, toSteps, type ChainStep } from './chain.js';
import { connectorLabel, fileSize } from './format.js';
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
}: {
  chatId: number;
  timezone: string;
  templates: MessageTemplateDto[] | null;
  onTemplates: (t: MessageTemplateDto[]) => void;
  onBack: () => void;
  /** Что-то отправили/присоединились — список чатов стоит обновить. */
  onChanged: () => void;
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
      <section className="chat-view">
        <ChatHeader title="Чат" onBack={onBack} />
        {loadError ? (
          <div className="notice error" role="alert">
            {loadError}
          </div>
        ) : (
          <p className="muted pad">Загрузка сообщений…</p>
        )}
      </section>
    );

  const crm = chat.crm;
  return (
    <section className="chat-view">
      <ChatHeader title={chat.title} subtitle={connectorLabel(chat.connector)} onBack={onBack}>
        {crm.dealId && (
          <button className="link" onClick={() => openCrm('deal', crm.dealId!)}>
            Сделка #{crm.dealId}
          </button>
        )}
        {crm.contactId && (
          <button className="link" onClick={() => openCrm('contact', crm.contactId!)}>
            Контакт #{crm.contactId}
          </button>
        )}
        {crm.leadId && (
          <button className="link" onClick={() => openCrm('lead', crm.leadId!)}>
            Лид #{crm.leadId}
          </button>
        )}
        <button onClick={() => openMessenger(chat.chatId)} title="Открыть диалог в мессенджере Битрикс24">
          В Битрикс24
        </button>
      </ChatHeader>

      <div className="chat-messages" ref={list} aria-live="polite">
        {chat.hasMore && (
          <button className="link older" onClick={() => void older()}>
            Показать более ранние
          </button>
        )}
        {chat.messages.map((m) => (
          <Message key={m.id} m={m} timezone={timezone} />
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
        <div className="composer">
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
    </section>
  );
}

function ChatHeader({
  title,
  subtitle,
  onBack,
  children,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="chat-header">
      <button className="chat-back" aria-label="К списку чатов" onClick={onBack}>
        ‹
      </button>
      <div className="chat-title">
        <strong>{title}</strong>
        {subtitle && <span className="muted">{subtitle}</span>}
      </div>
      <div className="chat-header-actions">{children}</div>
    </header>
  );
}

function Message({ m, timezone }: { m: ChatMessageDto; timezone: string }) {
  if (m.author.kind === 'system')
    return (
      <div className="msg system">
        {m.text} <span className="muted">{fmtDateTime(m.date, timezone)}</span>
      </div>
    );
  return (
    <div className={`msg ${m.author.kind === 'client' ? 'in' : 'out'}`}>
      <div className="msg-author">{m.author.name}</div>
      {m.text && <div className="msg-text">{m.text}</div>}
      {m.files.map((f) => (
        <a key={f.id} className="msg-file" href={f.url ?? undefined} target="_blank" rel="noreferrer">
          {f.type === 'image' && f.previewUrl ? <img src={f.previewUrl} alt={f.name} loading="lazy" /> : '📎'} {f.name}{' '}
          <span className="muted">{fileSize(f.size)}</span>
        </a>
      ))}
      <div className="msg-time">{fmtDateTime(m.date, timezone)}</div>
    </div>
  );
}
