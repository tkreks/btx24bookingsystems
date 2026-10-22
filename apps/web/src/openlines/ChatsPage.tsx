import { useCallback, useEffect, useRef, useState } from 'react';
import {
  todayIn,
  type ChatFolderDto,
  type ChatListDto,
  type ChatScope,
  type ChatSummary,
  type ClientBookingsDto,
  type CreateBookingResultDto,
  type MessageTemplateDto,
  type MyGroupDto,
} from '@btx24/shared';
import { BookingForm } from '../bookings/BookingForm.js';
import { PaymentDialog } from '../bookings/PaymentDialog.js';
import { ClientBookings } from '../bookings/ClientBookings.js';
import { apiDelete, apiGet, apiPost, apiPut } from '../api.js';
import { ChatView } from './ChatView.js';
import {
  avatarTone,
  CHAT_SORTS,
  chatsCount,
  initials,
  isFullPhone,
  visibleChats,
  type ChatSort,
  type ChatTab,
} from './chat-list.js';
import { Channel } from './Channel.js';
import { AUTHOR_PREFIX, shortTime } from './format.js';
import { Icon } from './icons.js';

const SCOPES: { key: ChatScope; label: string }[] = [
  { key: 'mine', label: 'Мои' },
  { key: 'department', label: 'Отдел' },
  { key: 'all', label: 'Все доступные' },
];
const TABS: { key: ChatTab; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'waiting', label: 'Ждут ответа' },
  { key: 'answered', label: 'Отвечены' },
];
/** Список чатов обновляем раз в 30 секунд, пока страница открыта. */
const POLL_MS = 15_000;
/** Чаты открытых линий: сверху — с самыми новыми сообщениями. Клик — открыть диалог. */
export function ChatsPage({
  timezone,
  canSend,
  initialChatId,
  initialWaiting = false,
  onClose,
  groups = [],
  onOpenDay,
}: {
  timezone: string;
  canSend: boolean;
  initialChatId?: number | null;
  initialWaiting?: boolean;
  onClose: () => void;
  /** Группы пользователя — для формы брони. */
  groups?: MyGroupDto[];
  /** Открыть день в календаре. */
  onOpenDay?: (date: string) => void;
}) {
  // По умолчанию — все доступные чаты и все статусы (решение владельца).
  const [scope, setScope] = useState<ChatScope>('all');
  const [tab, setTab] = useState<ChatTab>(initialWaiting ? 'waiting' : 'all');
  const [sort, setSort] = useState<ChatSort>('recent');
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  // Открытая папка (null — общий список, папки в нём строками).
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<ChatFolderDto[] | null>(null);
  const [foldersRev, setFoldersRev] = useState(0);
  const [cardMenu, setCardMenu] = useState<number | null>(null);
  const listKey = folderId ? `folder:${folderId}` : `scope:${scope}`;
  const listUrl = `/openlines/chats?scope=${scope}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}`;
  const [list, setList] = useState<{
    key: string;
    items: ChatSummary[];
    nextOffset: number | null;
    exactOrder: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<number | null>(initialChatId ?? null);
  const [templates, setTemplates] = useState<MessageTemplateDto[] | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<{ chatId: number; data: ClientBookingsDto | null; dealId?: number } | null>(null);
  const [created, setCreated] = useState<CreateBookingResultDto | null>(null);
  const [bookingsRev, setBookingsRev] = useState(0);
  const canCreate = groups.some((g) => g.permissions.includes('booking.create'));
  const canPay = groups.some((g) => g.permissions.includes('payment.send'));
  const [payment, setPayment] = useState<{ dealId: number; bookingId: number | null } | null>(null);
  const [paymentRev, setPaymentRev] = useState(0);
  // Полный номер телефона — поиск по всему порталу (CRM → чаты клиента), а не только в загруженных.
  const [phoneHits, setPhoneHits] = useState<{ q: string; items: ChatSummary[] | null; error: string } | null>(null);
  const fullPhone = isFullPhone(query);

  useEffect(() => {
    if (!fullPhone) return;
    let active = true;
    const q = query.trim();
    const timer = setTimeout(() => {
      setPhoneHits({ q, items: null, error: '' });
      apiGet<ChatListDto>(`/openlines/chats/search?q=${encodeURIComponent(q)}`).then(
        (r) => active && setPhoneHits({ q, items: r.items, error: '' }),
        (e) => active && setPhoneHits({ q, items: [], error: e instanceof Error ? e.message : 'Поиск не удался' }),
      );
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, fullPhone]);

  const refresh = useCallback(async () => {
    try {
      const page = await apiGet<ChatListDto>(listUrl);
      setList((prev) => {
        // Обновление первой страницы не теряет подгруженные «ещё».
        if (prev?.key !== listKey) return { key: listKey, ...page };
        const fresh = new Set(page.items.map((c) => c.chatId));
        const tail = prev.items.filter((c) => !fresh.has(c.chatId));
        return {
          key: listKey,
          // Порядок задаёт сервер (как в списке диалогов Битрикс24) — не пересортировываем.
          items: [...page.items, ...tail],
          nextOffset: prev.nextOffset ?? page.nextOffset,
          exactOrder: page.exactOrder,
        };
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить чаты');
    }
    setFoldersRev((n) => n + 1);
  }, [listKey, listUrl]);

  useEffect(() => {
    let active = true;
    void apiGet<ChatListDto>(listUrl).then(
      (page) => active && setList({ key: listKey, ...page }),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось загрузить чаты'),
    );
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [listKey, listUrl, refresh]);

  // Мои папки: строки в общем списке (последнее сообщение, непрочитанные).
  useEffect(() => {
    let active = true;
    apiGet<ChatFolderDto[]>('/openlines/folders').then(
      (f) => active && setFolders(f),
      () => active && setFolders([]),
    );
    return () => {
      active = false;
    };
  }, [foldersRev]);

  const folderAction = async (run: () => Promise<unknown>) => {
    setCardMenu(null);
    try {
      await run();
      // Список целиком заново: чат ушёл в папку или вернулся — дописывание «хвоста» его бы оставило.
      setList({ key: listKey, ...(await apiGet<ChatListDto>(listUrl)) });
      setFoldersRev((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось изменить папку');
    }
  };
  const newFolder = async (chatId?: number) => {
    const name = prompt('Название папки (например: Охрана, Ресепшн, АХО)')?.trim();
    if (!name) return;
    await folderAction(async () => {
      const { id } = await apiPost<{ id: string }>('/openlines/folders', { name });
      if (chatId) await apiPut(`/openlines/folders/${id}/chats/${chatId}`, {});
    });
  };
  const currentFolder = folders?.find((f) => f.id === folderId) ?? null;

  useEffect(() => {
    if (!canSend) return;
    let active = true;
    void apiGet<MessageTemplateDto[]>('/openlines/templates').then(
      (t) => active && setTemplates(t),
      () => active && setTemplates([]),
    );
    return () => {
      active = false;
    };
  }, [canSend]);

  // Меню закрывается кликом мимо и по Esc.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menu]);

  // Меню «в папку» у карточки — закрыть кликом мимо или Esc.
  useEffect(() => {
    if (cardMenu === null) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest?.('.cl-card-menu, .cl-card-more'))
        setCardMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [cardMenu]);

  const more = async () => {
    if (!list?.nextOffset) return;
    setLoadingMore(true);
    try {
      const page = await apiGet<ChatListDto>(`${listUrl}&offset=${list.nextOffset}`);
      const known = new Set(list.items.map((c) => c.chatId));
      setList({
        key: listKey,
        items: [...list.items, ...page.items.filter((c) => !known.has(c.chatId))],
        nextOffset: page.nextOffset,
        exactOrder: page.exactOrder,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить чаты');
    } finally {
      setLoadingMore(false);
    }
  };

  const current = list?.key === listKey ? list : null;
  const all = current?.items ?? [];
  const waiting = all.filter((c) => c.waitingReply).length;
  const counts: Record<ChatTab, number> = { all: all.length, waiting, answered: all.length - waiting };
  const hits = fullPhone && phoneHits?.q === query.trim() ? phoneHits : null;
  // По номеру: найденные по всему порталу + совпавшие среди загруженных (без повторов).
  // Найденные сервером уже совпали по номеру — их фильтруем только по вкладке.
  const local = visibleChats(all, tab, query, sort);
  const items = fullPhone
    ? [
        ...visibleChats(hits?.items ?? [], tab, '', sort),
        ...local.filter((c) => !hits?.items?.some((h) => h.chatId === c.chatId)),
      ]
    : local;

  return (
    <div className={`chats-page${openId ? ' has-open' : ''}`}>
      <aside className="cl-panel" aria-label="Список чатов">
        <div className="cl-top">
          <div className="cl-title-row">
            <button className="cl-btn" aria-label="Назад" title="Назад" onClick={onClose}>
              <Icon name="back" size={21} />
            </button>
            <div className="cl-heading">
              <div className="cl-heading-line">
                <h1>Чаты</h1>
                {waiting > 0 && (
                  <span className="cl-count" title="Ждут ответа">
                    {waiting}
                  </span>
                )}
              </div>
              <p className="cl-caption">
                {current?.exactOrder === false ? 'Порядок приблизительный' : 'Сначала новые сообщения'}
              </p>
            </div>
            <button className="cl-btn" aria-label="Обновить" title="Обновить" onClick={() => void refresh()}>
              <Icon name="refresh" />
            </button>
            <div className="cl-menu-wrap" ref={menuRef}>
              <button
                className={`cl-btn${menu ? ' active' : ''}`}
                aria-label="Сортировка"
                aria-expanded={menu}
                title="Сортировка"
                onClick={() => setMenu(!menu)}
              >
                <Icon name="filter" size={21} />
              </button>
              {menu && (
                <div className="cl-menu" role="menu">
                  <div className="cl-menu-label">Сортировка</div>
                  {CHAT_SORTS.map((s) => (
                    <button
                      key={s.key}
                      role="menuitemradio"
                      aria-checked={sort === s.key}
                      className={`cl-menu-item${sort === s.key ? ' active' : ''}`}
                      onClick={() => {
                        setSort(s.key);
                        setMenu(false);
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <label className="cl-search">
            <Icon name="search" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Имя, телефон, канал, сообщение…"
              aria-label="Поиск чатов"
              autoComplete="off"
            />
            {query && (
              <button className="cl-search-clear" aria-label="Очистить поиск" onClick={() => setQuery('')}>
                <Icon name="close" size={16} />
              </button>
            )}
          </label>

          {folderId ? (
            <div className="cl-folder-head">
              <button className="link" onClick={() => setFolderId(null)}>
                ← Все чаты
              </button>
              <strong>📁 {currentFolder?.name ?? 'Папка'}</strong>
              <span className="row-actions">
                <button
                  title="Переименовать папку"
                  aria-label="Переименовать папку"
                  onClick={() => {
                    const name = prompt('Новое название папки', currentFolder?.name ?? '')?.trim();
                    if (name) void folderAction(() => apiPut(`/openlines/folders/${folderId}`, { name }));
                  }}
                >
                  ✎
                </button>
                <button
                  title="Удалить папку (чаты вернутся в общий список)"
                  aria-label="Удалить папку"
                  onClick={() => {
                    if (!confirm(`Удалить папку «${currentFolder?.name ?? ''}»? Её чаты вернутся в общий список.`)) return;
                    void folderAction(async () => {
                      await apiDelete(`/openlines/folders/${folderId}`);
                      setFolderId(null);
                    });
                  }}
                >
                  ×
                </button>
              </span>
            </div>
          ) : (
          <div className="cl-scope" role="group" aria-label="Чьи чаты">
            {SCOPES.map((s) => (
              <button
                key={s.key}
                className={scope === s.key ? 'active' : ''}
                aria-pressed={scope === s.key}
                onClick={() => setScope(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          )}

          <nav className="cl-tabs" aria-label="Фильтр по статусу">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`cl-tab${tab === t.key ? ' active' : ''}`}
                aria-pressed={tab === t.key}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                <span className={`cl-tab-counter${t.key === 'waiting' && counts.waiting ? ' alert' : ''}`}>
                  {current ? counts[t.key] : '…'}
                </span>
              </button>
            ))}
          </nav>
          <div className="cl-list-caption">
            <span>{fullPhone ? (hits?.items ? 'Найдено по номеру' : 'Ищем по номеру…') : 'Переписки'}</span>
            <span>{current ? chatsCount(items.length) : ''}</span>
          </div>
        </div>

        <div className="cl-list" role="list" aria-label="Чаты">
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {hits?.error && (
            <div className="notice error" role="alert">
              {hits.error}
            </div>
          )}
          {!current && !error && <p className="cl-empty">Загрузка чатов…</p>}
          {current && !items.length && (
            <div className="cl-empty">
              <strong>{query || tab !== 'all' ? 'Чаты не найдены' : 'Чатов нет'}</strong>
              {(query || tab !== 'all') && <p>Попробуйте изменить запрос или фильтр</p>}
              {scope !== 'all' && <p>Чаты коллег — во вкладке «Все доступные».</p>}
            </div>
          )}
          {!folderId && !query && tab === 'all' && !!folders?.length && (
            <div className="cl-folders" aria-label="Папки">
              {folders.map((f) => (
                <button key={f.id} className="cl-folder" onClick={() => setFolderId(f.id)}>
                  <span className="cl-folder-icon" aria-hidden="true">
                    📁
                  </span>
                  <span className="cl-card-body">
                    <span className="cl-card-heading">
                      <span className="cl-card-name">
                        {f.name} <span className="muted">· {f.chatCount}</span>
                      </span>
                      <time className="cl-card-time">{f.last ? shortTime(f.last.date, timezone) : ''}</time>
                    </span>
                    <span className="cl-card-bottom">
                      <span className="cl-preview">
                        {f.last ? `${f.last.title}: ${AUTHOR_PREFIX[f.last.author]}${f.last.preview}` : 'Чатов пока нет'}
                      </span>
                      {f.unread > 0 && <span className="cl-unread">{f.unread}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {items.map((c) => (
            <div key={c.chatId} className="cl-card-wrap">
              <ChatCard
                c={c}
                active={openId === c.chatId}
                timezone={timezone}
                onOpen={() => {
                  setOpenId(c.chatId);
                  setCreated(null);
                }}
              />
              <button
                className="cl-card-more"
                aria-label={`Папка для чата ${c.title}`}
                title="В папку"
                aria-expanded={cardMenu === c.chatId}
                onClick={() => setCardMenu(cardMenu === c.chatId ? null : c.chatId)}
              >
                ⋯
              </button>
              {cardMenu === c.chatId && (
                <div className="cl-menu cl-card-menu" role="menu">
                  <div className="cl-menu-label">{c.folderId ? 'Перенести в папку' : 'В папку'}</div>
                  {folders
                    ?.filter((f) => f.id !== c.folderId)
                    .map((f) => (
                      <button
                        key={f.id}
                        role="menuitem"
                        className="cl-menu-item"
                        onClick={() => void folderAction(() => apiPut(`/openlines/folders/${f.id}/chats/${c.chatId}`, {}))}
                      >
                        📁 {f.name}
                      </button>
                    ))}
                  <button role="menuitem" className="cl-menu-item" onClick={() => void newFolder(c.chatId)}>
                    + Новая папка…
                  </button>
                  {c.folderId && (
                    <button
                      role="menuitem"
                      className="cl-menu-item"
                      onClick={() => void folderAction(() => apiDelete(`/openlines/folder-chats/${c.chatId}`))}
                    >
                      Убрать из папки
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {current?.nextOffset !== null && current && (
            <button className="link more" disabled={loadingMore} onClick={() => void more()}>
              {loadingMore ? 'Загрузка…' : 'Показать ещё'}
            </button>
          )}
        </div>
      </aside>
      {openId ? (
        <ChatView
          key={openId}
          chatId={openId}
          timezone={timezone}
          templates={templates}
          onTemplates={setTemplates}
          onBack={() => setOpenId(null)}
          onChanged={() => void refresh()}
          onPayment={canPay ? (dealId) => setPayment({ dealId, bookingId: null }) : undefined}
          paymentRevision={paymentRev}
          bookings={
            <>
              <ClientBookings
                chatId={openId}
                timezone={timezone}
                canCreate={canCreate}
                revision={bookingsRev}
                onOpenDay={onOpenDay}
                onCreate={(data) => setForm({ chatId: openId, data })}
              />
              {created && (
                <p className="notice cb-created">
                  Бронь #{created.bookingId} создана{created.dealId ? ` в сделке #${created.dealId}` : ''}.
                  {created.warnings.length > 0 && ` ${created.warnings.join(' ')}`}
                </p>
              )}
            </>
          }
        />
      ) : (
        <main className="chat-view empty-chat">Выберите чат слева</main>
      )}
      {form && (
        <BookingForm
          groups={groups}
          timezone={timezone}
          wizard
          context={{
            date: todayIn(timezone),
            contactId: form.data?.contactId ?? null,
            dealId: form.dealId ?? null,
            clientName: items.find((c) => c.chatId === form.chatId)?.title ?? all.find((c) => c.chatId === form.chatId)?.title ?? null,
            openDeals: form.data?.openDeals ?? [],
          }}
          onClose={() => setForm(null)}
          onDone={(r, mode) => {
            setForm(null);
            setCreated(r);
            setBookingsRev((n) => n + 1);
            if (mode === 'prepayment' && r.dealId && canPay) setPayment({ dealId: r.dealId, bookingId: r.bookingId });
          }}
        />
      )}
      {payment && (
        <PaymentDialog
          dealId={payment.dealId}
          bookingId={payment.bookingId}
          timezone={timezone}
          onClose={() => {
            setPayment(null);
            setPaymentRev((n) => n + 1);
          }}
          onCreateBooking={
            canCreate && openId
              ? (dealId) => {
                  setPayment(null);
                  void apiGet<ClientBookingsDto>(`/openlines/chats/${openId}/bookings`).then(
                    (data) => setForm({ chatId: openId, data, dealId }),
                    () => setForm({ chatId: openId, data: null, dealId }),
                  );
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function ChatCard({ c, active, timezone, onOpen }: { c: ChatSummary; active: boolean; timezone: string; onOpen: () => void }) {
  const last = c.lastMessage;
  const incoming = last?.author === 'client';
  return (
    <button className={`cl-card${active ? ' selected' : ''}`} role="listitem" aria-current={active} onClick={onOpen}>
      <span className={`avatar a${avatarTone(c.chatId)}`}>{initials(c.title)}</span>
      <span className="cl-card-body">
        <span className="cl-card-heading">
          <span className="cl-card-name">{c.title}</span>
          <time className="cl-card-time">{last ? shortTime(last.date, timezone) : ''}</time>
        </span>
        <span className="cl-card-meta">
          <Channel connector={c.connector} />
          {last && (last.author === 'client' || last.author === 'employee') && (
            <span className={`cl-direction${incoming ? ' in' : ''}`}>
              <Icon name={incoming ? 'in' : 'out'} size={14} /> {incoming ? 'Вх.' : 'Исх.'}
            </span>
          )}
        </span>
        <span className="cl-card-bottom">
          <span className="cl-preview">
            {last ? `${AUTHOR_PREFIX[last.author]}${last.preview || (last.hasFiles ? '📎 Файл' : '')}` : 'Нет сообщений'}
          </span>
          {c.sessionClosed ? (
            <span className="cl-status closed">Закрыт</span>
          ) : (
            <span className={`cl-status ${c.waitingReply ? 'waiting' : 'answered'}`}>
              {c.waitingReply ? 'Ждёт ответ' : 'Отвечен'}
            </span>
          )}
        </span>
        {!c.joined && <span className="cl-not-joined">Вы не участник</span>}
        {c.unread > 0 && (
          <span className="cl-unread cl-card-unread" title="Непрочитанных сообщений">
            {c.unread}
          </span>
        )}
      </span>
    </button>
  );
}
