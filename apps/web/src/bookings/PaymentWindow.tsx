import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BOOKING_REQUIRED_MESSAGE,
  DEFAULT_PAYMENT_LINK_MESSAGE,
  messengerLabel,
  PAYMENT_KIND_LABELS,
  PAYMENT_MAX_FILES,
  PAYMENT_MAX_TIMEOUT_HOURS,
  PAYMENT_PURPOSES,
  PAYMENT_REQUEST_KINDS,
  type CreatePaymentDto,
  type DealInvoicesDto,
  type MessageTemplateDto,
  type MessengerDealTargetsDto,
  type MessengerKind,
  type PaymentDealOptionsDto,
  type PaymentFileDto,
  type PaymentPreviewDto,
  type PaymentRequestDto,
  type PaymentRequestKind,
} from '@btx24/shared';
import { ApiRequestError, apiGet, apiPost } from '../api.js';
import { ActiveInvoiceLink } from './ActiveInvoiceLink.js';
import { finishPendingPayment, pendingText, startPendingPayment } from './pending-payment.js';
import { openCrm } from '../b24.js';
import { MinimizeButton } from '../Minimize.js';
import { MessengerKindIcon } from '../messengers/MessengerSearchButton.js';
import { AttachmentButtons } from '../openlines/AttachmentButtons.js';
import { initials } from '../openlines/chat-list.js';
import { fmtLinePhone } from '../openlines/ChannelFilter.js';
import { Icon } from '../openlines/icons.js';
import { parseHours } from './CustomPaymentForm.js';
import { GroupIcon } from './group-icons.js';
import { MessagePreviewText } from './MessagePreview.js';
import { deadlinePreview } from './message-preview.js';
import { paymentFeedback } from './payment-feedback.js';

const SOURCE: Record<PaymentPreviewDto['source'], string> = {
  fixed: 'фиксированная сумма группы',
  manual: 'ручная сумма из сделки',
  percent: 'процент от суммы сделки',
  certificate: 'номинал сертификата (сумма сделки)',
  none: '',
};
const HOURS = [1, 3, 12, 24];
const num = (v: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v).replace(/[  ]/g, ' ');
const rub = (v: number) => `${num(v)} ₽`;
const fileSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);
const sameFiles = (a: PaymentFileDto[], b: PaymentFileDto[]) => a.length === b.length && a.every((f, i) => f.id === b[i].id);

/** «4 часа», «1 день 2 часа», «45 мин». */
export function durationRu(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  const plural = (n: number, one: string, few: string, many: string) => {
    const t = n % 100;
    const u = n % 10;
    return t > 10 && t < 20 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
  };
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const parts = [d && `${d} ${plural(d, 'день', 'дня', 'дней')}`, h && `${h} ${plural(h, 'час', 'часа', 'часов')}`, m && `${m} мин`].filter(Boolean);
  return parts.join(' ') || '0 мин';
}

/** Куда уйдёт ссылка: рабочий чат открытой линии, новый чат через наш номер или никуда (только счёт). */
type Channel = { id: string; title: string; sub?: string; kind: MessengerKind | 'chat' | 'none'; via?: NonNullable<CreatePaymentDto['via']> };
const ChannelLogo = ({ c, size = 26 }: { c: Pick<Channel, 'kind'>; size?: number }) =>
  c.kind === 'chat' || c.kind === 'none' ? (
    <span className={`pw-channel-logo ${c.kind}`} style={{ width: size, height: size }} aria-hidden="true">
      <Icon name={c.kind === 'chat' ? 'chats' : 'coin'} size={Math.round(size * 0.55)} />
    </span>
  ) : (
    <MessengerKindIcon kind={c.kind} size={size} />
  );

/**
 * Итог фоновой отправки: сообщение ушло — «отправлено»; ссылка ещё формируется — ждём (до 2 минут) и
 * смотрим статус заявки; не ушло — ошибка с причиной.
 */
async function settlePending(id: string, dealId: number, first: PaymentRequestDto): Promise<void> {
  let r = first;
  for (let i = 0; i < 24 && r.status === 'link_pending'; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    try {
      const d = await apiGet<DealInvoicesDto>(`/payments/invoices?dealId=${dealId}`);
      r = d.invoices.find((x) => x.request?.id === first.id)?.request ?? r;
    } catch {
      /* Повторим на следующем шаге. */
    }
  }
  if (r.messageSent) finishPendingPayment(id, { ok: true });
  else finishPendingPayment(id, { ok: false, error: `${paymentFeedback(r)}${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`.trim() });
}

/**
 * Окно «Получить оплату» (макет владельца 2026-10-30, prepayment-modal): вкладки вида платежа, блок
 * данных брони (клиент и сделка, ресурс и время, длительность и сумма сделки, сумма к оплате), сообщение
 * клиенту — текст и вложения правятся на эту отправку (шаблон группы не меняется), внизу — куда
 * отправить и «Отправить». Карточка звонка — своя компактная версия (`PaymentDialog`).
 */
export function PaymentWindow({
  dealId: initialDealId,
  bookingId: initialBookingId,
  initialAmount,
  fixedDeal = false,
  timezone,
  onClose,
  onCreateBooking,
  onOpenSettings,
  onSending,
}: {
  dealId: number;
  bookingId?: number | null;
  initialAmount?: number | null;
  fixedDeal?: boolean;
  timezone: string;
  onClose: () => void;
  onCreateBooking?: (dealId: number) => void;
  /** «Настройки сообщений» — шаблоны оплаты в настройках групп; нет — кнопки нет. */
  onOpenSettings?: () => void;
  /**
   * Встройка сделки: «Отправить» закрывает окно и открывает чат — сообщение там сразу, со статусом
   * «отправляется»; счёт и ссылка создаются в фоне (`pending-payment`). Нет — результат показывает само окно.
   */
  onSending?: () => void;
}) {
  const [dealId, setDealId] = useState(initialDealId);
  const [dealOptions, setDealOptions] = useState<PaymentDealOptionsDto | null>(null);
  const [bookingId, setBookingId] = useState<number | null>(initialBookingId ?? null);
  const [bookingChosen, setBookingChosen] = useState(!!initialBookingId);
  const [kind, setKind] = useState<PaymentRequestKind>(initialAmount || initialBookingId ? 'prepayment' : 'custom');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PaymentPreviewDto | null>(null);
  const [amount, setAmount] = useState('');
  // «Произвольная»: основание и срок ссылки.
  const [purpose, setPurpose] = useState(PAYMENT_PURPOSES[0]);
  const [hours, setHours] = useState('1');
  // Сообщение: null — как в шаблоне (сумма подставляется по полю «Сумма»); строка — правка сотрудника.
  const [text, setText] = useState<string | null>(null);
  const [files, setFiles] = useState<PaymentFileDto[]>([]);
  const [filesBusy, setFilesBusy] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplateDto[] | null>(null);
  // Текст показывается с подставленными значениями; правка — по нажатию (исходный текст с переменными).
  const [editingText, setEditingText] = useState(false);
  const [menu, setMenu] = useState<'templates' | 'files' | 'channels' | null>(null);
  const [targets, setTargets] = useState<MessengerDealTargetsDto | null | 'failed'>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeKind, setActiveKind] = useState<PaymentRequestKind | null>(null);
  const [copied, setCopied] = useState(false);
  const [submitted, setSubmitted] = useState<PaymentRequestDto | null>(null);
  // Свой ключ на сделку и вид платежа: повторное нажатие не выставит второй счёт.
  const keys = useRef(new Map<string, string>());
  const keyFor = (k: string) => {
    if (!keys.current.has(k)) keys.current.set(k, crypto.randomUUID());
    return keys.current.get(k)!;
  };

  useEffect(() => {
    apiGet<PaymentDealOptionsDto>(`/payments/deal-options?dealId=${initialDealId}`).then(
      (o) => {
        setDealOptions(o);
        if (!fixedDeal && !initialBookingId && o.defaultDealId && o.defaultDealId !== initialDealId) setDealId(o.defaultDealId);
      },
      () => undefined,
    );
  }, [initialDealId, initialBookingId, fixedDeal]);

  const resetMessage = () => {
    setText(null);
    setFiles([]);
  };
  const chooseDeal = (id: number) => {
    setDealId(id);
    setSubmitted(null);
    setGroupId(null);
    setBookingId(null);
    setBookingChosen(false);
    setPreview(null);
    setTargets(null);
    setChannelId(null);
    setError('');
    resetMessage();
  };
  const chooseKind = (k: PaymentRequestKind) => {
    if (k === kind) return;
    setKind(k);
    setSubmitted(null);
    setPreview(null);
    setTemplateId(null);
    // Сумму произвольной оплаты вводят сами; предоплату и доплату считает сервер.
    setAmount('');
    setError('');
    resetMessage();
  };

  useEffect(() => {
    const q = new URLSearchParams({ dealId: String(dealId), kind });
    if (bookingId) q.set('bookingId', String(bookingId));
    if (groupId) q.set('groupId', groupId);
    if (templateId && kind !== 'custom') q.set('templateId', templateId);
    let active = true;
    apiGet<PaymentPreviewDto>(`/payments/preview?${q}`).then(
      (p) => {
        if (!active) return;
        setPreview(p);
        // Сумма из мастера — для предоплаты по сделке мастера; иначе расчёт сервера.
        const given = kind === 'prepayment' && p.dealId === initialDealId && initialAmount ? initialAmount : null;
        if (kind !== 'custom') setAmount(given !== null ? num(given) : p.amount !== null ? num(p.amount) : '');
        setFiles(p.messageFiles ?? []);
        if (!bookingChosen && p.bookingId !== bookingId) setBookingId(p.bookingId);
      },
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось рассчитать счёт'),
    );
    return () => {
      active = false;
    };
  }, [dealId, kind, bookingId, bookingChosen, groupId, templateId, initialDealId, initialAmount]);

  // Статус выставленного счёта: пока ссылка формируется — обновляем.
  const refreshSubmitted = useCallback(
    () =>
      apiGet<DealInvoicesDto>(`/payments/invoices?dealId=${dealId}`).then(
        (d) => setSubmitted((prev) => (prev ? (d.invoices.find((i) => i.request?.id === prev.id)?.request ?? prev) : null)),
        () => undefined,
      ),
    [dealId],
  );
  const pending = submitted?.status === 'link_pending';
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void refreshSubmitted(), 5000);
    return () => clearInterval(t);
  }, [pending, refreshSubmitted]);

  // Куда отправить: рабочий чат есть — он по умолчанию; номера, где клиент найден, — по запросу (меню).
  const noChat = !!preview?.chatProblem;
  const loadTargets = useCallback(() => {
    if (targets !== null) return;
    void apiGet<MessengerDealTargetsDto>(`/messengers/deal-targets/${dealId}`).then(setTargets, () => setTargets('failed'));
  }, [dealId, targets]);
  useEffect(() => {
    if (noChat) loadTargets();
  }, [noChat, loadTargets]);
  const found = targets && targets !== 'failed' ? targets.targets.filter((t) => t.status === 'found' && t.to) : [];
  const channels: Channel[] = [
    ...(preview && !noChat ? [{ id: 'chat', title: 'Рабочий чат', sub: 'Открытая линия сделки', kind: 'chat' as const }] : []),
    ...found.map((t) => ({
      id: t.messenger.id,
      title: t.messenger.title || messengerLabel(t.messenger.kind),
      sub: fmtLinePhone(t.messenger.phone),
      kind: t.messenger.kind,
      via: { messengerId: t.messenger.id, to: t.to! },
    })),
    ...(noChat ? [{ id: 'none', title: 'Только выставить счёт', sub: 'Ссылку отправите сами', kind: 'none' as const }] : []),
  ];
  const channel = channels.find((c) => c.id === channelId) ?? (noChat ? (channels.find((c) => c.via) ?? (targets ? channels.find((c) => c.id === 'none') : undefined)) : channels[0]);
  const channelsLoading = noChat && targets === null;

  useEffect(() => {
    if (menu !== 'templates' || templates) return;
    apiGet<MessageTemplateDto[]>('/openlines/templates').then(
      (all) => setTemplates(all.filter((t) => t.purpose === 'payment')),
      () => setTemplates([]),
    );
  }, [menu, templates]);
  // Меню закрываются щелчком мимо.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.pw-menu-holder')) setMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const custom = kind === 'custom';
  const sum = Number(amount.replace(',', '.').replace(/\s/g, ''));
  const h = parseHours(hours);
  // Текст шаблона уже с суммой расчёта — пока сотрудник не правил текст, показываем его с суммой из поля.
  const rawText = preview?.messageText ?? '';
  const templateText = custom ? DEFAULT_PAYMENT_LINK_MESSAGE : preview?.amount && sum > 0 ? rawText.split(num(preview.amount)).join(num(sum)) : rawText;
  const shownText = text ?? templateText;
  // Своё сообщение — если сотрудник что-то поменял (текст, файлы, шаблон); иначе сервер шлёт шаблон группы.
  const ownMessage = custom || text !== null || !sameFiles(files, preview?.messageFiles ?? []) || !!templateId;
  const blocking = (preview?.problems ?? []).filter((p) => !(sum > 0 && /сумм/i.test(p)) && p !== BOOKING_REQUIRED_MESSAGE);
  const formError = custom
    ? !purpose.trim()
      ? 'Укажите основание'
      : !(sum > 0)
        ? 'Укажите сумму'
        : h === 'invalid'
          ? `Срок — целое число часов от 1 до ${PAYMENT_MAX_TIMEOUT_HOURS}`
          : ''
    : !(sum > 0)
      ? 'Укажите сумму'
      : '';
  const canSend = !!preview && !busy && !filesBusy && !blocking.length && !preview.bookingMissing && !formError && !!shownText.trim() && !!channel && !channelsLoading;

  const submit = async () => {
    if (!canSend || !preview || !channel) return;
    setBusy(true);
    setError('');
    setActiveKind(null);
    const pendingId = onSending
      ? startPendingPayment({
          dealId,
          text: pendingText(shownText.trim()),
          files: files.map((f) => f.name),
        })
      : null;
    onSending?.();
    try {
      const body: CreatePaymentDto & Record<string, unknown> = {
        idempotencyKey: keyFor(`${dealId}:${kind}:${bookingId ?? ''}:${custom ? `${purpose}:${sum}` : ''}`),
        dealId,
        kind,
        groupId: preview.groupId ?? undefined,
        amount: custom ? sum : sum > 0 && sum !== preview.amount ? sum : null,
        bookingId: custom ? null : (bookingId ?? null),
        ...(channel.via ? { via: channel.via } : {}),
        ...(ownMessage ? { message: shownText.trim(), fileIds: files.map((f) => f.id) } : {}),
        ...(custom ? { purpose: purpose.trim(), timeoutHours: h === 'invalid' ? null : h } : {}),
      };
      const r = await apiPost<PaymentRequestDto>('/payments', body);
      if (custom) keys.current.clear();
      setSubmitted(r);
      if (pendingId) void settlePending(pendingId, dealId, r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выставить счёт');
      if (pendingId) finishPendingPayment(pendingId, { ok: false, error: e instanceof Error ? e.message : 'Не удалось выставить счёт' });
      if (e instanceof ApiRequestError && e.code === 'PAYMENT_ACTIVE') setActiveKind(kind);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  const booking = preview?.bookings.find((b) => b.bookingId === bookingId) ?? null;
  const contactName = preview?.contact?.name ?? '';
  const amountLabel = custom ? 'Сумма, ₽' : kind === 'prepayment' ? 'Сумма предоплаты, ₽' : 'Сумма доплаты, ₽';

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet bk pw" role="dialog" aria-modal="true" aria-label="Получить оплату" onClick={(e) => e.stopPropagation()}>
        <header className="bk-head">
          <div>
            <h3>Счета сделки #{dealId}</h3>
            <div className="bk-sub">Получить оплату за бронь</div>
          </div>
          <div className="pw-head-actions">
            <MinimizeButton label="Оплата" />
            <button type="button" className="bk-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
              ×
            </button>
          </div>
        </header>

        <div className="pw-body">
          {((dealOptions && dealOptions.deals.length > 1) || (preview && preview.groupOptions.length > 1)) && (
            <div className="pw-context">
              {dealOptions && dealOptions.deals.length > 1 && (
                <label>
                  <span>Сделка</span>
                  <select value={dealId} onChange={(e) => chooseDeal(Number(e.target.value))}>
                    {!dealOptions.deals.some((d) => d.id === dealId) && <option value={dealId}>#{dealId} (не в работе)</option>}
                    {dealOptions.deals.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title} · #{d.id}
                        {d.createdAt ? ` · от ${new Date(d.createdAt).toLocaleDateString('ru-RU')}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {preview && preview.groupOptions.length > 1 && (
                <label>
                  <span>Группа</span>
                  <select
                    value={preview.groupId ?? ''}
                    onChange={(e) => {
                      setGroupId(e.target.value || null);
                      setPreview(null);
                      resetMessage();
                    }}
                  >
                    {!preview.groupId && <option value="">Выберите группу…</option>}
                    {preview.groupOptions.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}

          <div className="segmented pw-tabs" role="tablist" aria-label="Тип оплаты">
            {PAYMENT_REQUEST_KINDS.map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} disabled={busy} onClick={() => chooseKind(k)}>
                {PAYMENT_KIND_LABELS[k]}
              </button>
            ))}
          </div>

          {!preview && !error && <p className="muted pw-loading">Рассчитываем счёт…</p>}

          {preview && (
            <section className="pw-card pw-details" aria-label="Данные бронирования">
              <div className="pw-detail">
                <span className="pw-avatar" aria-hidden="true">
                  {contactName ? initials(contactName) : <Icon name="person" size={22} />}
                </span>
                <div className="pw-detail-body">
                  {preview.contact ? (
                    <button type="button" className="pw-link pw-primary" onClick={() => openCrm('contact', preview.contact!.id)}>
                      {preview.contact.name} <Icon name="external" size={13} />
                    </button>
                  ) : (
                    <div className="pw-primary muted">Клиент не указан</div>
                  )}
                  <button type="button" className="pw-link pw-secondary" onClick={() => openCrm('deal', dealId)}>
                    {preview.deal.title || `Сделка #${dealId}`} <Icon name="external" size={12} />
                  </button>
                </div>
              </div>

              <div className="pw-detail">
                <span className="pw-icon green" aria-hidden="true">
                  <GroupIcon name={booking?.resources[0] ?? preview.groupName ?? ''} size={24} />
                </span>
                <div className="pw-detail-body">
                  {custom ? (
                    <>
                      <div className="pw-primary">{booking ? `${booking.resources.join(', ')} · #${booking.bookingId}` : 'Без привязки к брони'}</div>
                      <div className="pw-secondary">{booking ? `${fmt(booking.start)} — ${fmt(booking.end)}` : 'Произвольный счёт бронь не снимает'}</div>
                    </>
                  ) : preview.bookings.length > 1 ? (
                    <>
                      <select
                        className="pw-booking-select"
                        aria-label="Бронь"
                        value={bookingId ?? ''}
                        onChange={(e) => {
                          setBookingChosen(true);
                          setBookingId(e.target.value ? Number(e.target.value) : null);
                          setGroupId(null);
                        }}
                      >
                        {!preview.requireBooking && <option value="">Без привязки к брони</option>}
                        {preview.bookings.map((b) => (
                          <option key={b.bookingId} value={b.bookingId}>
                            {b.resources.join(', ')} · #{b.bookingId}
                          </option>
                        ))}
                      </select>
                      <div className="pw-secondary">{booking ? `${fmt(booking.start)} — ${fmt(booking.end)}` : 'Не оплатят в срок — бронь не снимется'}</div>
                    </>
                  ) : booking ? (
                    <>
                      <div className="pw-primary">
                        {booking.resources.join(', ')} · #{booking.bookingId}
                      </div>
                      <div className="pw-secondary">
                        {fmt(booking.start)} — {fmt(booking.end)}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="pw-primary">{preview.bookingMissing ? 'Брони нет' : 'Без привязки к брони'}</div>
                      <div className="pw-secondary">{preview.groupName ? `Группа «${preview.groupName}»` : ''}</div>
                    </>
                  )}
                </div>
              </div>

              <div className="pw-detail">
                <span className="pw-icon" aria-hidden="true">
                  <Icon name={custom ? 'deal' : 'clock'} size={24} />
                </span>
                <div className="pw-detail-body">
                  {custom ? (
                    <>
                      <label className="pw-label" htmlFor="pw-purpose">
                        Основание
                      </label>
                      <div className="pw-chips" role="group" aria-label="Быстрый выбор основания">
                        {PAYMENT_PURPOSES.map((p) => (
                          <button key={p} type="button" className={purpose === p ? 'active' : ''} aria-pressed={purpose === p} onClick={() => setPurpose(p)}>
                            {p}
                          </button>
                        ))}
                      </div>
                      <input id="pw-purpose" className="pw-input" value={purpose} maxLength={200} placeholder="За что платит клиент" onChange={(e) => setPurpose(e.target.value)} />
                    </>
                  ) : (
                    <>
                      <div className="pw-label">Длительность</div>
                      <div className="pw-secondary">{booking ? durationRu(Date.parse(booking.end) - Date.parse(booking.start)) : '—'}</div>
                      <div className="pw-label pw-gap">Сумма сделки</div>
                      <div className="pw-total">{preview.deal.amount !== null ? rub(preview.deal.amount) : '—'}</div>
                    </>
                  )}
                </div>
              </div>

              <div className="pw-detail pw-detail-amount">
                <span className="pw-icon violet" aria-hidden="true">
                  <Icon name="coin" size={24} />
                </span>
                <div className="pw-detail-body">
                  <label className="pw-label" htmlFor="pw-amount">
                    {amountLabel}
                  </label>
                  <div className="pw-amount">
                    <input id="pw-amount" inputMode="decimal" value={amount} placeholder="0" disabled={busy || preview.bookingMissing} onChange={(e) => setAmount(e.target.value)} />
                    <span aria-hidden="true">₽</span>
                  </div>
                  {custom ? (
                    <>
                      <div className="pw-label pw-gap">Срок действия ссылки</div>
                      <div className="pw-chips" role="group" aria-label="Срок действия ссылки, часов">
                        {HOURS.map((x) => (
                          <button key={x} type="button" className={hours === String(x) ? 'active' : ''} aria-pressed={hours === String(x)} onClick={() => setHours(String(x))}>
                            {x} ч
                          </button>
                        ))}
                        <input className="pw-hours" inputMode="numeric" value={hours} aria-label="Часов (1–24, пусто — без срока)" placeholder="—" onChange={(e) => setHours(e.target.value)} />
                      </div>
                    </>
                  ) : (
                    preview.amount !== null && (
                      <div className="pw-hint">
                        Рассчитано: {rub(preview.amount)} — {SOURCE[preview.source]}
                        {preview.timeoutMinutes ? ` · на оплату ${durationRu(preview.timeoutMinutes * 60_000)}` : ''}
                      </div>
                    )
                  )}
                </div>
              </div>
            </section>
          )}

          {preview?.bookingMissing && (
            <div className="notice booking-required pw-notice" role="alert">
              <b>{BOOKING_REQUIRED_MESSAGE}.</b>
              {preview.pastBooking && (
                <span>
                  {' '}
                  Бронь #{preview.pastBooking.bookingId} ({fmt(preview.pastBooking.start)} — {fmt(preview.pastBooking.end)}) уже прошла — для предоплаты нужна бронь на будущее время.
                </span>
              )}
              {onCreateBooking && (
                <button type="button" className="primary" onClick={() => onCreateBooking(dealId)}>
                  + Создать бронь
                </button>
              )}
            </div>
          )}

          {preview && !preview.bookingMissing && (
            <section className="pw-card pw-message" aria-label="Сообщение клиенту">
              <div className="pw-section-head">
                <div className="pw-section-title">
                  <span className="pw-bubble" aria-hidden="true">
                    <Icon name="chat" size={20} />
                  </span>
                  <span>
                    Сообщение клиенту
                    {!custom && <small className="muted">{preview.templateName ? `шаблон «${preview.templateName}»` : 'стандартный текст'}</small>}
                  </span>
                </div>
                {!custom && (
                  <div className="pw-menu-holder">
                    <button type="button" className="pw-secondary-btn" aria-expanded={menu === 'templates'} onClick={() => setMenu(menu === 'templates' ? null : 'templates')}>
                      Шаблоны <Icon name="chevronDown" size={14} />
                    </button>
                    {menu === 'templates' && (
                      <div className="pw-menu" role="menu">
                        {!templates && <p className="muted">Загрузка…</p>}
                        {templates && !templates.length && <p className="muted">Шаблонов оплаты нет — их создают в настройках групп.</p>}
                        {templates?.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            role="menuitem"
                            className={preview.templateId === t.id ? 'active' : ''}
                            onClick={() => {
                              setMenu(null);
                              setTemplateId(t.id);
                              setText(null);
                              setPreview(null);
                            }}
                          >
                            <b>{t.name}</b>
                            <small className="muted">{t.steps.map((s) => s.text).join(' ').slice(0, 90)}</small>
                          </button>
                        ))}
                        {text !== null && (
                          <button type="button" role="menuitem" onClick={() => { setMenu(null); setText(null); }}>
                            <b>Вернуть текст шаблона</b>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {editingText ? (
                <>
                  <div className="pw-editor">
                    <textarea rows={4} maxLength={4000} autoFocus value={shownText} aria-label="Текст сообщения клиенту" disabled={busy} onChange={(e) => setText(e.target.value)} />
                  </div>
                  <p className="pw-hint">
                    <code>{'{link}'}</code> заменится ссылкой на оплату, <code>{'{deadline}'}</code> — сроком оплаты; без <code>{'{link}'}</code> ссылка встанет последней строкой. Шаблон группы не меняется.{' '}
                    <button type="button" className="link" onClick={() => setEditingText(false)}>
                      Показать с подставленными значениями
                    </button>
                  </p>
                </>
              ) : (
                <>
                  <div
                    className="pw-preview"
                    role="button"
                    tabIndex={0}
                    title="Нажмите, чтобы изменить текст на эту отправку"
                    aria-label="Текст сообщения клиенту — изменить"
                    onClick={() => !busy && setEditingText(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (!busy) setEditingText(true);
                      }
                    }}
                  >
                    <MessagePreviewText
                      text={shownText}
                      deadlineText={deadlinePreview(custom ? (typeof h === 'number' ? h * 60 : null) : (preview?.timeoutMinutes ?? null), timezone) || undefined}
                    />
                    <span className="pw-preview-edit" aria-hidden="true">
                      ✎ Изменить
                    </span>
                  </div>
                  <p className="pw-hint">Значения уже подставлены; ссылка на оплату появится при отправке. Нажмите на текст, чтобы изменить его на эту отправку — шаблон группы не меняется.</p>
                </>
              )}
              <div className="pw-attachments-head">
                <strong>
                  <Icon name="clip" size={16} /> Вложения ({files.length})
                </strong>
                <div className="pw-menu-holder">
                  <button
                    type="button"
                    className="pw-add-file"
                    disabled={busy || files.length >= PAYMENT_MAX_FILES}
                    aria-expanded={menu === 'files'}
                    onClick={() => setMenu(menu === 'files' ? null : 'files')}
                  >
                    <Icon name="plus" size={14} /> Добавить файл
                  </button>
                  <div className={`pw-menu pw-file-menu${menu === 'files' ? '' : ' hidden'}`}>
                    <AttachmentButtons
                      remaining={PAYMENT_MAX_FILES - files.length}
                      disabled={busy}
                      onBusyChange={setFilesBusy}
                      onAdd={(added) => {
                        setFiles((prev) => [...prev, ...added.filter((a) => !prev.some((p) => p.id === a.id))].slice(0, PAYMENT_MAX_FILES));
                        setMenu(null);
                      }}
                    />
                  </div>
                </div>
              </div>
              {!!files.length && (
                <div className="pw-files">
                  {files.map((f) => (
                    <div key={f.id} className="pw-file">
                      <span className="pw-file-preview" aria-hidden="true">
                        <Icon name={f.mime.startsWith('image/') ? 'camera' : 'clip'} size={18} />
                      </span>
                      <span className="pw-file-meta">
                        <span className="pw-file-name" title={f.name}>
                          {f.name}
                        </span>
                        <small className="muted">{fileSize(f.size)}</small>
                      </span>
                      <button type="button" aria-label={`Убрать «${f.name}»`} disabled={busy} onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}>
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {blocking.map((p) => (
            <p key={p} className="notice error pw-notice">
              {p}
            </p>
          ))}
          {error && (
            <p className="notice error pw-notice" role="alert">
              {error}
              {activeKind && (
                <>
                  {' '}
                  <ActiveInvoiceLink dealId={dealId} kind={activeKind} timezone={timezone} />
                </>
              )}
            </p>
          )}
          {submitted && !error && (
            <div className={`notice pw-notice ${submitted.error || (submitted.status === 'sent' && !submitted.messageSent) ? 'error' : 'success'}`} role="status">
              <b>{paymentFeedback(submitted)}</b>
              {submitted.warnings.map((w) => (
                <span key={w} className="muted">
                  {' '}
                  {w}
                </span>
              ))}
              {submitted.link && (
                <button type="button" className="link" onClick={() => void copy(submitted.link!)}>
                  {copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}
                </button>
              )}
            </div>
          )}
        </div>

        <footer className="pw-footer">
          {onOpenSettings ? (
            <button type="button" className="link pw-settings" onClick={onOpenSettings}>
              <Icon name="settings" size={16} /> Настройки сообщений
            </button>
          ) : (
            <span />
          )}
          <div className="pw-send-controls">
            <div className="pw-menu-holder">
              <button
                type="button"
                className="pw-channel-button"
                aria-label={channel ? `Куда отправить: ${channel.title}` : 'Куда отправить'}
                aria-expanded={menu === 'channels'}
                title={channel ? `${channel.title}${channel.sub ? ` · ${channel.sub}` : ''}` : 'Куда отправить'}
                disabled={busy || !preview}
                onClick={() => {
                  loadTargets();
                  setMenu(menu === 'channels' ? null : 'channels');
                }}
              >
                <span className="pw-stack">
                  {channel ? (
                    <ChannelLogo c={channel} />
                  ) : (
                    channels.slice(0, 4).map((c) => <ChannelLogo key={c.id} c={c} />)
                  )}
                  {channelsLoading && <span className="spinner" aria-label="Ищем клиента в мессенджерах" />}
                </span>
                <Icon name="chevronUp" size={14} />
              </button>
              {menu === 'channels' && (
                <div className="pw-menu pw-channel-menu" role="menu">
                  {channels.map((c) => (
                    <button key={c.id} type="button" role="menuitemradio" aria-checked={channel?.id === c.id} className={channel?.id === c.id ? 'active' : ''} onClick={() => { setChannelId(c.id); setMenu(null); }}>
                      <ChannelLogo c={c} />
                      <span>
                        <b>{c.title}</b>
                        {c.sub && <small className="muted">{c.sub}</small>}
                      </span>
                    </button>
                  ))}
                  {targets === null && <p className="muted">Ищем клиента в мессенджерах…</p>}
                  {targets === 'failed' && <p className="muted">Не удалось найти клиента в мессенджерах.</p>}
                  {targets && targets !== 'failed' && !found.length && <p className="muted">{targets.contact ? 'Клиент не найден в наших номерах.' : 'У сделки нет контакта.'}</p>}
                </div>
              )}
            </div>
            <button type="button" className="primary pw-send" disabled={!canSend} title={formError || undefined} onClick={() => void submit()}>
              <Icon name="send" size={16} /> {busy ? 'Отправляем…' : channel?.kind === 'none' ? 'Выставить счёт' : 'Отправить'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
