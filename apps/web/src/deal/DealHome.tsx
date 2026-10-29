import { useEffect, useState } from 'react';
import {
  messageChannel,
  type AttentionChatDto,
  type ChatFlagDto,
  type ChatSummary,
  type ClientBookingsDto,
  type DealChatsDto,
  type MessageTemplateDto,
  type MyGroupDto,
  type ServiceChatDto,
} from '@btx24/shared';
import { apiGet, apiPost, apiPut } from '../api.js';
import { openCrm } from '../b24.js';
import { PaymentDialog } from '../bookings/PaymentDialog.js';
import { AttentionMessage } from '../dashboard/AttentionMessage.js';
import { ChatRowMenu } from '../dashboard/ChatRowMenu.js';
import { ClientInvoicesBlock } from './ClientInvoicesBlock.js';
import { LoadProgress } from '../dashboard/LoadProgress.js';
import { ResourceTimelineBlock } from '../dashboard/ResourceTimelineBlock.js';
import { BindChatDialog } from '../messengers/BindChatDialog.js';
import { DealNewChatDialog } from '../messengers/DealNewChatDialog.js';
import { DealChatStart } from './DealChatStart.js';
import { ServiceChatView } from './ServiceChatView.js';
import { hasDisabledWazzupChannel } from '../openlines/channel-error.js';
import { ChatView } from '../openlines/ChatView.js';
import { HideChatDialog } from '../openlines/DashboardPage.js';
import { Icon, type IconName } from '../openlines/icons.js';

/** Чат, куда писать нельзя: линия выключена или канал не подключён (Wazzup), либо Wazzup сообщил «канал выключен». */
export function isDeadChat(c: ChatSummary): boolean {
  return !!c.lineProblem || hasDisabledWazzupChannel(c.connector, c.lastMessage?.preview);
}

/** Почему в чат нельзя писать (для «Присоединиться к чату»); null — рабочий. */
export function deadReason(c: ChatSummary | undefined): string | null {
  return c && isDeadChat(c) ? (c.lineProblem ?? 'канал Wazzup выключен') : null;
}

/** Бронь этой сделки для шкалы: текущая/будущая, иначе последняя прошедшая. */
export function dealBookingStart(info: ClientBookingsDto | null, dealId: number): string | null {
  if (!info) return null;
  const own = (list: ClientBookingsDto['upcoming'] | undefined) => (list ?? []).filter((b) => b.dealId === dealId);
  return own(info.upcoming)[0]?.start ?? info.openDeals.find((d) => d.id === dealId)?.booking?.start ?? own(info.recent)[0]?.start ?? null;
}

/** Чат клиента — строкой «Последних сообщений» дашборда. */
export function chatRow(c: ChatSummary): AttentionChatDto {
  return {
    chatId: c.chatId,
    unread: c.unread,
    title: c.title,
    clientName: c.clientName,
    clientAvatar: c.clientAvatar ?? null,
    connector: c.connector,
    lastMessageAt: c.lastMessage?.date ?? '',
    preview: c.lastMessage?.preview ?? '',
    hasFiles: c.lastMessage?.hasFiles ?? false,
    dealId: c.crm.dealId,
    contactId: c.crm.contactId,
    responsibleId: c.responsibleId,
    flag: c.flag ?? null,
  };
}

/** Группы шкалы — воронки сделки; воронка неизвестна или групп на ней нет — все группы с календарём. */
export function dealGroups(groups: MyGroupDto[], categoryId: number | null | undefined): string[] {
  if (categoryId === null || categoryId === undefined) return [];
  return groups.filter((g) => g.dealCategoryId === categoryId && g.permissions.includes('calendar.view')).map((g) => g.id);
}

type Action = { key: 'pay' | 'book' | 'template'; icon: IconName; title: string; hint: string };
const ACTIONS: Action[] = [
  { key: 'pay', icon: 'coin', title: 'Получить оплату', hint: 'Ссылка на оплату: основание, сумма, срок' },
  { key: 'book', icon: 'calendar', title: 'Мастер бронирования', hint: 'Новая бронь по этой сделке' },
  { key: 'template', icon: 'send', title: 'Отправить шаблон', hint: 'Шаблон сообщения в чат клиента' },
];

/**
 * Встройка сделки (решение владельца 2026-10-26): слева — чаты клиента (больше одного — список как
 * «Последние сообщения» дашборда; нажатие открывает только чат, «назад» — к списку, рядом
 * «обновить» — перечитать чат и список), справа сверху —
 * шкала броней ресурсов воронки сделки (дата и группа), справа снизу — быстрые действия: ссылка на
 * оплату, мастер бронирования, шаблон в чат.
 */
export function DealHome({
  dealId,
  timezone,
  groups,
  dealInfo,
  canBook,
  canPay,
  onBooking,
  timelinePending = false,
}: {
  dealId: number;
  timezone: string;
  groups: MyGroupDto[];
  /** Брони и открытые сделки клиента (`/deals/:id/bookings`): воронка сделки, клиент для мастера. */
  dealInfo: ClientBookingsDto | null;
  /** Право создавать брони (проверит и сервер). */
  canBook: boolean;
  /** Право выставлять счета (`payment.send`). */
  canPay: boolean;
  /** Мастер брони (с проверкой: есть ли уже бронь по сделке). */
  onBooking: () => void;
  /** Группы и воронка сделки ещё грузятся — шкала ждёт, не показывая чужую группу. */
  timelinePending?: boolean;
}) {
  const [data, setData] = useState<DealChatsDto | null>(null);
  const [error, setError] = useState('');
  const [rev, setRev] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  /** Нажали «назад» в единственном чате — показать список, а не снова этот чат. */
  const [listed, setListed] = useState(false);
  /** «Обновить» — чат перечитывается заново (как перезагрузка страницы, но только блок). */
  const [reload, setReload] = useState(0);
  const [templates, setTemplates] = useState<MessageTemplateDto[] | null>(null);
  const [templatesRequest, setTemplatesRequest] = useState(0);
  const [hiding, setHiding] = useState<AttentionChatDto | null>(null);
  const [flagError, setFlagError] = useState('');
  const [paying, setPaying] = useState(false);
  const [invoicesOf, setInvoicesOf] = useState<number | null>(null);
  /** Новый чат: `chatId` — «Присоединиться к чату» в неработающем канале (наш номер этого канала), без него — любой мессенджер. */
  const [newChat, setNewChat] = useState<{ kind: string | null; chatId?: number } | null>(null);
  const [binding, setBinding] = useState(false);
  /** Служебный чат сделки (клиент без мессенджеров); undefined — ещё грузится. */
  const [service, setService] = useState<ServiceChatDto | null | undefined>(undefined);
  /** Что показано вместо списка: служебный чат или поиск клиента в мессенджерах. */
  const [pane, setPane] = useState<'service' | 'start' | null>(null);
  const [paymentRev, setPaymentRev] = useState(0);
  useEffect(() => {
    let active = true;
    void apiGet<DealChatsDto>(`/openlines/deal-chats/${dealId}`).then(
      (d) => active && (setData(d), setError('')),
      (e) => active && setError(e instanceof Error ? e.message : 'Чаты клиента недоступны'),
    );
    return () => {
      active = false;
    };
  }, [dealId, rev]);
  useEffect(() => {
    let active = true;
    void apiGet<ServiceChatDto>(`/deals/${dealId}/service-chat`).then(
      (d) => active && setService(d.chat ? d : null),
      () => active && setService(null),
    );
    return () => {
      active = false;
    };
  }, [dealId, rev]);
  useEffect(() => {
    let active = true;
    void apiGet<MessageTemplateDto[]>('/openlines/templates').then(
      (t) => active && setTemplates(t),
      () => active && setTemplates([]),
    );
    return () => {
      active = false;
    };
  }, []);

  const items = data?.items ?? [];
  // Чат один — сразу он (неработающий — с «Присоединиться к чату»), «назад» — к списку. Чатов нет —
  // служебный чат сделки, если он есть, иначе поиск клиента в мессенджерах.
  const single = items.length === 1;
  const shownId = pane ? null : (openId ?? (single && !listed ? items[0].chatId : null));
  const auto = !!data && !items.length && service !== undefined && !listed ? (service ? 'service' : 'start') : null;
  const shownPane = shownId ? null : (pane ?? auto);
  const toList = () => {
    setOpenId(null);
    setPane(null);
    setListed(true);
  };
  const openChat = (id: number) => {
    setPane(null);
    setOpenId(id);
  };
  const createService = async () => {
    const d = await apiPost<ServiceChatDto>(`/deals/${dealId}/service-chat`);
    setService(d);
    setPane('service');
  };
  const refresh = () => {
    setReload((n) => n + 1);
    setRev((n) => n + 1);
  };
  const shown = items.find((c) => c.chatId === shownId);
  const categoryId = dealInfo?.openDeals.find((d) => d.id === dealId)?.categoryId;
  const timelineGroups = dealGroups(groups, categoryId);

  const toggleFlag = (c: AttentionChatDto) =>
    apiPut<ChatFlagDto>(`/openlines/chats/${c.chatId}/flag`, { on: !c.flag }).then(
      (r) => {
        setFlagError('');
        setData((d) => (d ? { ...d, items: d.items.map((x) => (x.chatId === r.chatId ? { ...x, flag: r.flag } : x)) } : d));
      },
      (e) => setFlagError(e instanceof Error ? e.message : 'Не удалось поставить «!»'),
    );
  const sendTemplate = () => {
    if (!shownId) openChat(items.find((c) => !isDeadChat(c))?.chatId ?? items[0]?.chatId);
    setTemplatesRequest((n) => n + 1);
  };
  const run = (a: Action['key']) => (a === 'pay' ? setPaying(true) : a === 'book' ? onBooking() : sendTemplate());
  const disabled = (a: Action['key']): string =>
    a === 'pay' ? (canPay ? '' : 'Нет права выставлять счета') : a === 'book' ? (canBook ? '' : 'Нет права создавать брони') : !data ? 'Загружаем чаты…' : items.length ? '' : 'Нет чата с клиентом';

  return (
    <div className="deal-ws">
      <section className="day-panel dash-block deal-ws-chat">
        {shownPane === 'service' ? (
          <ServiceChatView dealId={dealId} timezone={timezone} onBack={toList} onFind={() => setPane('start')} onBind={() => setBinding(true)} />
        ) : shownPane === 'start' ? (
          <div className="dash-attention deal-ws-chats">
            <p className="dash-attention-title muted">
              {(items.length > 0 || service) && (
                <button type="button" className="cl-btn chat-back" aria-label="К списку чатов" title="К чатам" onClick={toList}>
                  <Icon name="back" />
                </button>
              )}
              Чат с клиентом
            </p>
            <DealChatStart
              dealId={dealId}
              hasServiceChat={!!service}
              onOpenChat={(id) => {
                setRev((n) => n + 1);
                openChat(id);
              }}
              onServiceChat={createService}
              onBind={() => setBinding(true)}
            />
          </div>
        ) : shownId ? (
          <ChatView
            key={`${shownId}:${reload}`}
            chatId={shownId}
            timezone={timezone}
            templates={templates}
            onTemplates={setTemplates}
            templatesRequest={templatesRequest}
            onBack={toList}
            dead={deadReason(shown)}
            onRevive={() => setNewChat({ kind: shown ? messageChannel(shown.connector) : null, chatId: shownId })}
            menu={[
              { key: 'search', icon: 'search', label: 'Другой мессенджер', title: 'Поиск в другом мессенджере', onClick: () => setNewChat({ kind: null }) },
              { key: 'bind', icon: 'link', label: 'Привязать чат', title: 'Привязать к клиенту сделки чат из мессенджера', onClick: () => setBinding(true) },
            ]}
            onRefresh={refresh}
            onChanged={() => setRev((n) => n + 1)}
            status={shown}
            onStatus={(r) => setData((d) => (d ? { ...d, items: d.items.map((c) => (c.chatId === r.chatId ? { ...c, waitingReply: r.waitingReply, noReply: r.noReply } : c)) } : d))}
            onOpenChat={openChat}
            onPayment={canPay ? (id) => setInvoicesOf(id) : undefined}
            paymentRevision={paymentRev}
          />
        ) : (
          <div className="dash-attention deal-ws-chats">
            <p className="dash-attention-title muted">
              Чаты клиента
              {data && <span className="pill">{items.length}</span>}
              <button type="button" className="cl-btn chat-refresh" aria-label="Обновить чаты" title="Обновить чаты" onClick={refresh}>
                <Icon name="refresh" />
              </button>
              <span className="deal-ws-chats-actions">
                <button type="button" className="cl-btn" title="Найти клиента в мессенджерах и начать переписку" onClick={() => setPane('start')}>
                  Новый чат
                </button>
                <button type="button" className="cl-btn" title="Привязать к клиенту сделки чат из мессенджера" onClick={() => setBinding(true)}>
                  Привязать чат
                </button>
              </span>
            </p>
            {!data && !error && <p className="muted"><LoadProgress name="deal-chats" label="Загрузка чатов" /></p>}
            {error && <p className="notice error" role="alert">{error}</p>}
            {flagError && <p className="notice error" role="alert">{flagError}</p>}
            {data && !items.length && !service && <p className="muted">Чатов с клиентом сделки нет.</p>}
            <ul className="attention-rows">
              {service && (
                <li className="service-chat-row">
                  <button type="button" className="service-chat-open" onClick={() => setPane('service')}>
                    <Icon name="settings" size={18} />
                    <span>
                      <b>Служебный чат</b>
                      <span className="muted">
                        {service.messages.length ? service.messages[service.messages.length - 1].text.slice(0, 120) : 'Только в приложении: ссылки на оплату и автоматика'}
                      </span>
                    </span>
                  </button>
                </li>
              )}
              {items.map((s) => {
                const c = chatRow(s);
                const dead = isDeadChat(s);
                return (
                  <li key={c.chatId} className={[c.flag ? 'flagged' : '', dead ? 'dead' : ''].filter(Boolean).join(' ') || undefined}>
                    <AttentionMessage chat={c} timezone={timezone} onOpen={() => openChat(c.chatId)} />
                    <span className="attention-actions">
                      <button
                        className={`dash-icon-btn cl-flag${c.flag ? ' on' : ''}`}
                        aria-pressed={!!c.flag}
                        title={c.flag ? `«!» — ${c.flag.byName ?? 'сотрудник'}; снимется, когда менеджер ответит клиенту. Нажмите — снять` : '«!» — видно всем, пока менеджер не ответит клиенту'}
                        aria-label={c.flag ? 'Снять «!»' : 'Отметить «!»'}
                        onClick={() => void toggleFlag(c)}
                      >
                        !
                      </button>
                      <ChatRowMenu dealId={c.dealId} onDeal={() => c.dealId && openCrm('deal', c.dealId)} onChat={() => openChat(c.chatId)} onHide={() => setHiding(c)} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      {canPay && <ClientInvoicesBlock dealId={dealId} timezone={timezone} revision={paymentRev} />}

      <div className="deal-ws-timeline">
        <ResourceTimelineBlock
          groups={groups}
          config={timelineGroups}
          timezone={timezone}
          groupTabs
          pending={timelinePending}
          focus={dealBookingStart(dealInfo, dealId)}
          deal={{ dealId, contactId: dealInfo?.contactId ?? null, openDeals: dealInfo?.openDeals ?? [] }}
        />
      </div>

      <section className="day-panel dash-block deal-ws-actions">
        <p className="dash-attention-title muted">Быстрые действия · сделка #{dealId}</p>
        <div className="deal-ws-action-list">
          {ACTIONS.map((a) => {
            const why = disabled(a.key);
            return (
              <button key={a.key} type="button" className={`deal-ws-action ${a.key}`} disabled={!!why} title={why || a.hint} onClick={() => run(a.key)}>
                <span className="deal-ws-action-icon" aria-hidden="true">
                  <Icon name={a.icon} size={22} />
                </span>
                <span className="deal-ws-action-text">
                  <b>{a.title}</b>
                  <span className="muted">{why || a.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {paying && (
        <PaymentDialog
          dealId={dealId}
          timezone={timezone}
          onClose={() => {
            setPaying(false);
            setPaymentRev((n) => n + 1);
          }}
          onCreateBooking={
            canBook
              ? () => {
                  setPaying(false);
                  onBooking();
                }
              : undefined
          }
        />
      )}
      {invoicesOf !== null && (
        <PaymentDialog
          dealId={invoicesOf}
          timezone={timezone}
          onClose={() => {
            setInvoicesOf(null);
            setPaymentRev((n) => n + 1);
          }}
        />
      )}
      {hiding && <HideChatDialog chat={hiding} onClose={() => setHiding(null)} onHidden={() => setHiding(null)} />}
      {newChat && (
        <DealNewChatDialog
          dealId={dealId}
          chatId={newChat.chatId}
          kind={newChat.kind}
          onClose={() => setNewChat(null)}
          onOpenChat={(id) => {
            setRev((n) => n + 1);
            openChat(id);
          }}
        />
      )}
      {binding && (
        <BindChatDialog
          dealId={dealId}
          timezone={timezone}
          onBound={() => setRev((n) => n + 1)}
          onClose={() => setBinding(false)}
        />
      )}
    </div>
  );
}

/**
 * По сделке уже есть бронь: менеджеру — создать новую сделку с тем же клиентом или игнорировать
 * (открыть календарь). `checking` — брони сделки ещё проверяются.
 */
export function DealBookingWarning({
  booking,
  checking,
  creating,
  error,
  canCreate,
  onCreate,
  onIgnore,
  onClose,
}: {
  booking: string | null;
  checking: boolean;
  creating: boolean;
  error: string;
  canCreate: boolean;
  onCreate: () => void;
  onIgnore: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop deal-warning-backdrop" role="presentation" onClick={onClose}>
      <section className="deal-warning" role="alertdialog" aria-modal="true" aria-labelledby="deal-warning-title" onClick={(e) => e.stopPropagation()}>
        {checking ? (
          <p className="deal-warning-checking" role="status">
            <span className="spinner" aria-hidden="true" /> Проверяем бронирования сделки…
          </p>
        ) : (
          <>
            <span className="deal-warning-icon" aria-hidden="true">
              <Icon name="alert" size={26} />
            </span>
            <h2 id="deal-warning-title">По этой сделке есть бронирование</h2>
            {booking && <p className="deal-warning-booking">{booking}</p>}
            <p className="muted">Для новой брони создайте новую сделку — клиент будет тот же.</p>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <div className="deal-warning-actions">
              {canCreate && (
                <button type="button" className="primary" disabled={creating} onClick={onCreate}>
                  {creating ? 'Создаём сделку…' : 'Создать новую сделку'}
                </button>
              )}
              <button type="button" disabled={creating} onClick={onIgnore}>
                Игнорировать
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
