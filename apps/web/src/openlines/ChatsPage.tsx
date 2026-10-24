import { messageChannel } from '@btx24/shared';
import { connectorLabel } from './format.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  todayIn,
  type ChatFolderDto,
  type ChatListDto,
  type ChatScope,
  type ChatSummary,
  type ClientBookingsDto,
  type MessageTemplateDto,
  type MyGroupDto,
} from '@btx24/shared';
import { BookingForm } from '../bookings/BookingForm.js';
import { ErrorBoundary } from '../ErrorBoundary.js';
import { PaymentDialog } from '../bookings/PaymentDialog.js';
import { ClientBookings } from '../bookings/ClientBookings.js';
import { apiDelete, apiGet, apiPost, apiPut } from '../api.js';
import { ChatView } from './ChatView.js';
import {
  avatarTone,
  dayKey,
  CHAT_SORTS,
  chatsCount,
  initials,
  isFullPhone,
  visibleChats,
  type ChatSort,
  type ChatTab,
} from './chat-list.js';
import { Channel } from './Channel.js';
import { AUTHOR_PREFIX, clipName, shortTime } from './format.js';
import { MessengersButton } from '../messengers/MessengersButton.js';
import { Icon } from './icons.js';

const TABS: { key: ChatTab; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'waiting', label: 'Ждут ответа' },
  { key: 'mine', label: 'Мои' },
];
/** Список чатов обновляем раз в 15 секунд, пока страница открыта. */
const POLL_MS = 15_000;
/** Чаты открытых линий: сверху — с самыми новыми сообщениями. Клик — открыть диалог. */
export function ChatsPage({
  timezone,
  canSend,
  initialChatId,
  initialWaiting = false,
  period: initialPeriod,
  onClose,
  groups = [],
  onOpenDay,
}: {
  timezone: string;
  canSend: boolean;
  initialChatId?: number | null;
  initialWaiting?: boolean;
  period?: { from: string; to: string };
  onClose: () => void;
  /** Группы пользователя — для формы брони. */
  groups?: MyGroupDto[];
  /** Открыть день в календаре. */
  onOpenDay?: (date: string) => void;
}) {
  // По умолчанию — все доступные чаты и все статусы (решение владельца).
  const [tab, setTab] = useState<ChatTab>(initialWaiting ? 'waiting' : 'all');
  const scope: ChatScope = tab === 'mine' ? 'mine' : 'all';
  const [period, setPeriod] = useState(initialPeriod);
  const [sort, setSort] = useState<ChatSort>('recent');
  const [query, setQuery] = useState('');
  const [channel, setChannel] = useState('');
  const [menu, setMenu] = useState(false);
  // Открытая папка (null — общий список, папки в нём строками).
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<ChatFolderDto[] | null>(null);
  const [foldersRev, setFoldersRev] = useState(0);
  const [cardMenu, setCardMenu] = useState<number | null>(null);
  const periodQuery = period ? `&from=${period.from}&to=${period.to}` : '';
  const listKey = `${folderId ?? ''}|${scope}|${tab}|${periodQuery}`;
  const listUrl = `/openlines/chats?scope=${scope}&status=${tab === 'waiting' ? 'waiting' : 'all'}${periodQuery}${channel ? `&channel=${encodeURIComponent(channel)}` : ''}${folderId ? `&folder=${encodeURIComponent(folderId)}` : ''}`;
  const [list, setList] = useState<{
    key: string;
    items: ChatSummary[];
    nextOffset: number | null;
    exactOrder: boolean;
    counts?: ChatListDto['counts'];
    userId?: number;
    channels?: string[];
  } | null>(null);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<number | null>(initialChatId ?? null);
  const [templates, setTemplates] = useState<MessageTemplateDto[] | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<{ chatId: number; data: ClientBookingsDto | null; dealId?: number } | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [bookingsRev, setBookingsRev] = useState(0);
  const canCreate = groups.some((g) => g.permissions.includes('booking.create'));
  const canPay = groups.some((g) => g.permissions.includes('payment.send'));
  const [payment, setPayment] = useState<{ dealId: number; bookingId: number | null; amount?: number | null; fixedDeal?: boolean } | null>(null);
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

  const activeKey = useRef(listKey);
  activeKey.current = listKey;
  const listRef = useRef(list);
  useEffect(() => { listRef.current = list; }, [list]);
  const refresh = useCallback(async () => {
    try {
      const page = await apiGet<ChatListDto>(listUrl);
      const wanted = listRef.current?.key === listKey ? listRef.current.items.length : page.items.length;
      let items = [...page.items];
      let nextOffset = page.nextOffset;
      while (nextOffset !== null && items.length < wanted) {
        const next = await apiGet<ChatListDto>(`${listUrl}&offset=${nextOffset}`);
        const seen = new Set(items.map((c) => c.chatId));
        items = [...items, ...next.items.filter((c) => !seen.has(c.chatId))];
        if (next.nextOffset === nextOffset) break;
        nextOffset = next.nextOffset;
      }
      if (activeKey.current !== listKey) return;
      setList({ key: listKey, ...page, items, nextOffset });
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
        counts: page.counts,
        userId: page.userId,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить чаты');
    } finally {
      setLoadingMore(false);
    }
  };

  const current = list?.key === listKey ? list : null;
  const all = current?.items ?? [];
  const counts: Record<ChatTab, number> = current?.counts ?? { all: all.length, waiting: all.filter((c) => c.waitingReply).length, mine: all.filter((c) => c.responsibleId === current?.userId).length };
  const waiting = counts.waiting;
  const hits = fullPhone && phoneHits?.q === query.trim() ? phoneHits : null;
  // По номеру: найденные по всему порталу + совпавшие среди загруженных (без повторов).
  // Найденные сервером уже совпали по номеру — их фильтруем только по вкладке.
  const local = visibleChats(all, tab, query, sort);
  const searched = (hits?.items ?? []).filter((c) => (!channel || messageChannel(c.connector) === channel) && (tab !== 'mine' || c.responsibleId === current?.userId) && (!period || (c.lastMessage && dayKey(c.lastMessage.date, timezone) >= period.from && dayKey(c.lastMessage.date, timezone) <= period.to)));
  const items = fullPhone
    ? [
        ...visibleChats(searched, tab, '', sort),
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
            <MessengersButton timezone={timezone} />
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
              <button className="link cl-folder-back" onClick={() => setFolderId(null)}>
                ← Все чаты
              </button>
              <strong className="cl-folder-title" title={currentFolder?.name}>
                {currentFolder ? folderIcon(currentFolder) : '📁'} {currentFolder?.name ?? 'Папка'}
              </strong>
              {/* Папка коллеги — только значки; пояснение — подсказкой над значком. */}
              {currentFolder && !currentFolder.mine && (
                <span className="row-actions">
                  <span className="cl-icon-tip" tabIndex={0} data-tip="Глобальная папка коллеги: менять её может только владелец" aria-label="Глобальная папка коллеги">
                    🌐
                  </span>
                  {currentFolder.ignoreAttention && (
                    <span className="cl-icon-tip" tabIndex={0} data-tip="Не обращать внимания: чаты папки не попадают на дашборд" aria-label="Не обращать внимания">
                      🔕
                    </span>
                  )}
                </span>
              )}
              {currentFolder?.mine && currentFolder.kind !== 'favorites' && (
              <span className="row-actions">
                <button
                  className={`cl-icon-tip${currentFolder.global ? ' on' : ''}`}
                  aria-pressed={currentFolder.global}
                  aria-label={currentFolder.global ? 'Глобальная папка' : 'Личная папка'}
                  data-tip={
                    currentFolder.global
                      ? 'Глобальная: папку и доступные им чаты видят все сотрудники, «Не обращать внимания» — у всех. Нажмите — сделать личной'
                      : 'Личная: видите только вы. Нажмите — сделать глобальной'
                  }
                  onClick={() => void folderAction(() => apiPut(`/openlines/folders/${folderId}`, { global: !currentFolder.global }))}
                >
                  {currentFolder.global ? '🌐' : '👤'}
                </button>
                <button
                  className={`cl-icon-tip${currentFolder.ignoreAttention ? ' on' : ''}`}
                  aria-pressed={currentFolder.ignoreAttention}
                  aria-label={currentFolder.ignoreAttention ? 'Не обращать внимания' : 'Обращать внимание'}
                  data-tip={
                    currentFolder.ignoreAttention
                      ? 'Не обращать внимания: чаты папки не попадают в «Требуют внимания» и «ждут ответа» на дашборде. Нажмите — обращать внимание'
                      : 'Обращать внимание: чаты папки — на дашборде. Нажмите — не обращать внимания'
                  }
                  onClick={() => void folderAction(() => apiPut(`/openlines/folders/${folderId}`, { ignoreAttention: !currentFolder.ignoreAttention }))}
                >
                  {currentFolder.ignoreAttention ? '🔕' : '🔔'}
                </button>
                <button
                  className="cl-icon-tip"
                  data-tip="Переименовать папку"
                  aria-label="Переименовать папку"
                  onClick={() => {
                    const name = prompt('Новое название папки', currentFolder?.name ?? '')?.trim();
                    if (name) void folderAction(() => apiPut(`/openlines/folders/${folderId}`, { name }));
                  }}
                >
                  ✎
                </button>
                <button
                  className="cl-icon-tip"
                  data-tip="Удалить папку (чаты вернутся в общий список)"
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
              )}
            </div>
          ) : null}

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
          {period && <p className="cl-period muted">Последнее сообщение: {period.from} — {period.to} <button type="button" className="link" onClick={() => setPeriod(undefined)}>Все даты</button></p>}
          <label className="cl-channel-filter">Канал сообщений <select aria-label="Канал сообщений" value={channel} onChange={e=>{setChannel(e.target.value);setOpenId(null);}}>
            <option value="">Все каналы</option>
            {[...new Set([...(current?.channels ?? []), ...(current?.items ?? []).map(c=>messageChannel(c.connector)), ...(channel ? [channel] : [])])].sort().map(code=><option key={code} value={code}>{connectorLabel(code)}</option>)}
          </select></label>
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
              {scope !== 'all' && <p>Чаты коллег — во вкладке «Все».</p>}
            </div>
          )}
          {!folderId && !query && !period && tab === 'all' && !!folders?.length && (
            <div className="cl-folders" aria-label="Папки">
              {folders.map((f) => (
                <button key={f.id} className={`cl-folder${f.kind === 'favorites' ? ' fav' : ''}`} onClick={() => setFolderId(f.id)}>
                  <span className="cl-folder-icon" title={f.kind === 'favorites' ? 'Избранное' : f.global ? (f.mine ? 'Глобальная папка (ваша)' : 'Глобальная папка коллеги') : 'Папка'}>
                    <span aria-hidden="true">{folderIcon(f)}</span>
                                          <span className={`cl-unread cl-badge${f.unread ? '' : ' empty'}`} title={`Непрочитанных в папке: ${f.unread}`}>
                        {f.unread > 99 ? '99+' : f.unread}
                      </span>
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
                      {f.ignoreAttention && <span className="cl-folder-flag" title="Не обращать внимания: чаты не на дашборде">🔕</span>}
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
              {/* Под аватаркой: папка (меню), входящее/исходящее, участник ли я. */}
              <span className="cl-card-tools">
                <button
                  className={`cl-star${c.favorite ? ' on' : ''}`}
                  aria-pressed={c.favorite}
                  aria-label={c.favorite ? 'Убрать из избранного' : 'В избранное'}
                  title={c.favorite ? 'Убрать из избранного' : 'В избранное (только у вас)'}
                  onClick={() => void folderAction(() => (c.favorite ? apiDelete(`/openlines/favorites/${c.chatId}`) : apiPut(`/openlines/favorites/${c.chatId}`, {})))}
                >
                  {c.favorite ? '★' : '☆'}
                </button>
                <button
                  className="cl-card-more"
                  aria-label={`Папка для чата ${c.clientName || c.title}`}
                  title={c.folderId ? 'Перенести в другую папку' : 'В папку'}
                  aria-expanded={cardMenu === c.chatId}
                  onClick={() => setCardMenu(cardMenu === c.chatId ? null : c.chatId)}
                >
                  <Icon name="folder" size={15} />
                </button>
                {c.lastMessage && (c.lastMessage.author === 'client' || c.lastMessage.author === 'employee') && (
                  <span
                    className={`cl-dir ${c.lastMessage.author === 'client' ? 'in' : 'out'}`}
                    title={c.lastMessage.author === 'client' ? 'Последнее — входящее от клиента' : 'Последнее — исходящее от сотрудника'}
                  >
                    <Icon name={c.lastMessage.author === 'client' ? 'arrowDown' : 'arrowUp'} size={14} />
                  </span>
                )}
                <span className={`cl-member${c.joined ? '' : ' no'}`} title={c.joined ? 'Вы участник чата' : 'Вы не участник чата'}>
                  <Icon name="person" size={14} />
                </span>
              </span>
              {cardMenu === c.chatId && (
                <div className="cl-menu cl-card-menu" role="menu">
                  <div className="cl-menu-label">{c.folderId ? 'Перенести в папку' : 'В папку'}</div>
                  {folders
                    ?.filter((f) => f.id !== c.folderId && f.mine && f.kind !== 'favorites')
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
                  {c.folderId && folders?.find((f) => f.id === c.folderId)?.mine && (
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
          status={(list?.items ?? []).concat(phoneHits?.items ?? []).find((c) => c.chatId === openId)}
          onStatus={(r) => {
            // Отметка общая: в списке сразу, остальные сотрудники увидят при обновлении.
            const apply = (items: ChatSummary[]) => items.map((c) => (c.chatId === r.chatId ? { ...c, waitingReply: r.waitingReply, noReply: r.noReply } : c));
            setList((prev) => (prev ? { ...prev, items: apply(prev.items) } : prev));
            setPhoneHits((prev) => (prev?.items ? { ...prev, items: apply(prev.items) } : prev));
          }}
          onOpenChat={(id) => {
            setOpenId(id);
            setCreated(null);
          }}
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
                <p className="notice cb-created">{created}</p>
              )}
            </>
          }
        />
      ) : (
        <main className="chat-view empty-chat">Выберите чат слева</main>
      )}
      {form && (
        <ErrorBoundary where="booking-form" onClose={() => setForm(null)}>
          <BookingForm
            groups={groups}
            timezone={timezone}
            context={{
              date: todayIn(timezone),
              contactId: form.data?.contactId ?? null,
              dealId: form.dealId ?? null,
              clientName: ((c) => c?.clientName || c?.title || null)([...items, ...all].find((c) => c.chatId === form.chatId)),
              openDeals: form.data?.openDeals ?? [],
            }}
            onClose={() => setForm(null)}
            onDone={(r) => {
              setForm(null);
              setCreated(r.note);
              setBookingsRev((n) => n + 1);
              if (r.payment && r.dealId && canPay)
                setPayment({ dealId: r.dealId, bookingId: r.booking?.bookingId ?? null, amount: r.payment.amount, fixedDeal: r.payment.fixedDeal });
            }}
          />
        </ErrorBoundary>
      )}
      {payment && (
        <PaymentDialog
          dealId={payment.dealId}
          bookingId={payment.bookingId}
          initialAmount={payment.amount}
          fixedDeal={payment.fixedDeal}
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
  // Имя клиента из CRM; название чата — это название сделки/линии («Имя - WAZZUP - …»).
  const name = c.clientName || c.title;
  return (
    <button className={`cl-card${active ? ' selected' : ''}`} role="listitem" aria-current={active} onClick={onOpen}>
      {/* Непрочитанные — в правом верхнем углу аватарки («Не требует ответа» обнуляет). */}
      <span className="cl-avatar-wrap">
        <span className={`avatar a${avatarTone(c.chatId)}`}>{initials(name)}</span>
                  <span className={`cl-unread cl-badge${c.unread ? '' : ' empty'}`} title={`Непрочитанных сообщений: ${c.unread}`}>
            {c.unread > 99 ? '99+' : c.unread}
          </span>
      </span>
      <span className="cl-card-body">
        <span className="cl-card-heading">
          <span className="cl-card-name" title={name}>
            {clipName(name)}
          </span>
          <time className="cl-card-time">{last ? shortTime(last.date, timezone) : ''}</time>
        </span>
        <span className="cl-card-meta">
          <Channel connector={c.connector} />
        </span>
        <span className="cl-card-bottom">
          <span className="cl-preview">
            {last ? `${AUTHOR_PREFIX[last.author]}${last.preview || (last.hasFiles ? '📎 Файл' : '')}` : 'Нет сообщений'}
          </span>
          {c.sessionClosed ? (
            <span className="cl-status closed">Закрыт</span>
          ) : (
            <span className={`cl-status ${c.waitingReply ? 'waiting' : c.noReply ? 'noreply' : 'answered'}`} title={c.noReply?.byName ? `Отметил: ${c.noReply.byName}` : undefined}>
              {c.waitingReply ? 'Ждёт ответ' : c.noReply ? 'Не требует ответа' : 'Отвечен'}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/** Значок папки: ★ — избранное, 🌐 — глобальная, 📁 — личная. */
function folderIcon(f: Pick<ChatFolderDto, 'kind' | 'global'>): string {
  return f.kind === 'favorites' ? '★' : f.global ? '🌐' : '📁';
}
