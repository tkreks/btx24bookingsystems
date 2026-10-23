/** Контракты открытых линий и дашборда менеджера (`/api/openlines/*`, `/api/dashboard`). */

/** Чьи диалоги показывать: свои, отдела (с вложенными) или все, что разрешает CRM. */
export const CHAT_SCOPES = ['mine', 'department', 'all'] as const;
export type ChatScope = (typeof CHAT_SCOPES)[number];

export type MessageAuthorKind = 'client' | 'employee' | 'bot' | 'system';

/** Привязки диалога к CRM (из `entity_data_2` чата). */
export interface ChatCrmLinks {
  leadId: number | null;
  contactId: number | null;
  companyId: number | null;
  dealId: number | null;
}

export interface ChatSummary {
  chatId: number;
  sessionId: number;
  title: string;
  /** Имя клиента из CRM (контакт / компания / лид); null — нет привязки. */
  clientName: string | null;
  /** Канал: whatsapp, telegram, livechat, … (из `entity_id` чата). */
  connector: string;
  responsibleId: number | null;
  lastMessage: { id: number; date: string; author: MessageAuthorKind; preview: string; hasFiles: boolean } | null;
  /** Последнее значимое сообщение — от клиента, сессия открыта и никто не отметил «Не требует ответа». */
  waitingReply: boolean;
  /** «Не требует ответа» — общая отметка (кто и когда); действует до нового сообщения клиента. */
  noReply: { byName: string | null; at: string } | null;
  /** Пользователь — участник чата (иначе сначала «Присоединиться»). */
  joined: boolean;
  sessionClosed: boolean;
  crm: ChatCrmLinks;
  /** Телефоны клиента из привязанных контакта / лида / компании (для поиска; не сохраняются). */
  phones: string[];
  /** Непрочитанных сообщений у меня (счётчик мессенджера). */
  unread: number;
  /** Моя папка, где лежит чат; null — в общем списке. */
  folderId: string | null;
}

/** Личная папка чатов (`/api/openlines/folders`): строка в списке чатов. */
export interface ChatFolderDto {
  id: string;
  name: string;
  sort: number;
  chatCount: number;
  /** Непрочитанных сообщений во всех чатах папки. */
  unread: number;
  /** Последнее сообщение среди чатов папки. */
  last: { chatId: number; title: string; preview: string; date: string; author: MessageAuthorKind } | null;
  /** «Не обращать внимания»: чаты папки не попадают в «Требуют внимания» на дашборде. */
  ignoreAttention: boolean;
}

export interface ChatListDto {
  items: ChatSummary[];
  /** Смещение следующей страницы; null — больше нет. */
  nextOffset: number | null;
  /**
   * true — порядок точный, по последнему сообщению клиента или оператора (индекс включён «сбором
   * метаданных диалогов»); false — приблизительный, по дате изменения сессии в CRM.
   */
  exactOrder: boolean;
}

export interface ChatFileDto {
  id: number;
  name: string;
  size: number;
  type: string;
  /** Ссылки портала (открываются с авторизацией Битрикс24 в браузере). */
  previewUrl: string | null;
  url: string | null;
}

export interface ChatMessageDto {
  id: number;
  date: string;
  author: { id: number; name: string; kind: MessageAuthorKind };
  text: string;
  files: ChatFileDto[];
  /** Отправлено менеджером с телефона (рабочий WhatsApp через Wazzup) — наше сообщение. */
  viaPhone?: boolean;
}

export interface ChatHistoryDto {
  chatId: number;
  title: string;
  connector: string;
  joined: boolean;
  /** Можно ли отправлять: участник чата и право `openlines.send` в группе. */
  canSend: boolean;
  crm: ChatCrmLinks;
  /** По возрастанию времени. */
  messages: ChatMessageDto[];
  /** Есть сообщения старше первого — запросить с `beforeId`. */
  hasMore: boolean;
}

/** Шаг цепочки: текст и/или вложения (`StoredFile.id`). Отправляются по порядку. */
export interface TemplateStepDto {
  text: string;
  fileIds: string[];
}

export interface StoredFileDto {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface MessageTemplateDto {
  id: string;
  name: string;
  /** Общий (системный) шаблон — виден всем сотрудникам портала. */
  shared: boolean;
  /** `chat` — для чатов; `payment` — системный шаблон сообщения со ссылкой на оплату (выбирает группа). */
  purpose: MessageTemplatePurpose;
  /** Мой шаблон (я автор). */
  mine: boolean;
  /** Можно менять: свой личный или общий для администратора приложения. */
  canEdit: boolean;
  steps: (TemplateStepDto & { files: StoredFileDto[] })[];
  updatedAt: string;
}

export type MessageTemplatePurpose = 'chat' | 'payment';

export interface SaveTemplateDto {
  name: string;
  /** Общий шаблон — только администратор приложения. */
  shared?: boolean;
  /** Шаблон оплаты — только администратор, всегда общий. */
  purpose?: MessageTemplatePurpose;
  steps: TemplateStepDto[];
}

/** `POST /api/openlines/chats/:chatId/send` — цепочка сообщений. */
export interface SendChainDto {
  steps: TemplateStepDto[];
}

export interface SendResultDto {
  /** Сколько шагов отправлено (при ошибке — до какого дошли). */
  sent: number;
  messageIds: number[];
  error: { step: number; code: string; message: string } | null;
}

/** Самый длинный период дашборда, дней. */
export const DASHBOARD_MAX_DAYS = 92;

/** Бронь из журнала приложения (создана через приложение) — строка списков дашборда. */
export interface DashboardBookingRow {
  bookingId: number;
  dealId: number | null;
  /** null — сделка недоступна пользователю в CRM (или служебная бронь). */
  deal: { title: string; opportunity: number | null; currency: string | null; client: string | null } | null;
  resources: string[];
  /** Начало и конец брони (UTC, ISO). */
  start: string;
  end: string;
  status: 'active' | 'cancelled';
  cancelReason: 'payment_timeout' | 'manual' | 'removed_in_bitrix' | null;
  createdAt: string;
  cancelledAt: string | null;
  /** Откуда бронь: создана приложением или найдена в Битрикс24 (сверкой). */
  source: 'app' | 'bitrix';
  /** Название брони в Битрикс24 (снимок) — если сделки нет или она недоступна. */
  title: string | null;
  /** Кто создал / снял (сотрудник); null — Битрикс24 или система. */
  createdBy: string | null;
  cancelledBy: string | null;
  /** Бронь приложения пропала в Битрикс24 — ждёт решения в «Уведомлениях о бронях». */
  pendingRemoval: boolean;
}

export interface DashboardDto {
  /** Период — дни `[from, to]` включительно (YYYY-MM-DD) в часовом поясе портала. */
  from: string;
  to: string;
  /**
   * null — нет права на открытые линии ни в одной группе. Счётчики «сейчас», не за период:
   * ждут ответа — среди **всех доступных** сотруднику чатов; `attention` — последние сообщения
   * клиентов, на которые ещё не ответили (новые сверху).
   */
  chats: { waitingReply: number; attention: AttentionChatDto[] } | null;
  /** Активные брони на ресурсах групп пользователя: на сегодня и на завтра (пересекают день) — и сами брони. */
  bookingDays: { today: number; tomorrow: number; todayItems: DashboardBookingRow[]; tomorrowItems: DashboardBookingRow[] };
  /** Клиенты по видам звонков за период; null — нет доступа к делам CRM. */
  calls: Record<CallKind, number> | null;
  /** Все звонки за период (входящие и исходящие, по `callsScope`); null — нет доступа к делам CRM. */
  callsTotal: number | null;
  /**
   * Новые сделки — созданные за период в воронках групп пользователя (по `callsScope`: мои — где я
   * ответственный), и сколько из них от повторных клиентов. null — нет доступа к сделкам CRM.
   */
  newDeals: { total: number; repeat: number; items: DashboardNewDeal[]; truncated: boolean } | null;
  callsScope: CallScope;
  /** Воронка для «повторных» и доступные воронки (из групп пользователя). */
  callsFunnel: number | null;
  callFunnels: CallFunnelDto[];
  /**
   * Брони из журнала за период — все, что видит сверка, а не только созданные приложением (ресурсы групп
   * пользователя; «Мои» — создал или снял я): новые (появились за период) и удалённые (сняты, не оплачены,
   * удалены в Битрикс24 — в журнале остаются навсегда).
   */
  bookings: { created: { total: number; items: DashboardBookingRow[] }; removed: { total: number; items: DashboardBookingRow[] } };
}

/** Новая сделка за период: повторный клиент — у контакта есть состоявшаяся сделка той же воронки раньше. */
export interface DashboardNewDeal {
  id: number;
  title: string;
  createdAt: string;
  opportunity: number | null;
  currency: string | null;
  contact: { id: number; name: string | null } | null;
  repeat: boolean;
  /** Бронь по сделке (журнал приложения): нет, есть, есть и оплачена (счёт приложения оплачен). */
  booking: 'none' | 'booked' | 'paid';
  /** Источник сделки (SOURCE_ID и название из справочника CRM); null — не указан. */
  source: { id: string; name: string } | null;
}

/**
 * Звонки на дашборде — **по клиентам**, не по звонкам: клиент, позвонивший 3 раза, которому
 * перезвонили 2 раза, — один клиент. Входящие делятся на новых и повторных (есть выигранная
 * сделка в выбранной воронке, закрытая до его первого звонка в периоде).
 */
export const CALL_KINDS = ['incoming', 'new', 'repeat', 'answered', 'missed', 'lost'] as const;
export type CallKind = (typeof CALL_KINDS)[number];
export const CALL_KIND_LABELS: Record<CallKind, string> = {
  incoming: 'Входящие',
  new: 'Уникальные',
  repeat: 'Повторные',
  answered: 'Отвеченные',
  missed: 'Пропущенные',
  lost: 'Упущенные',
};

/** Чьи звонки: свои (ответственный — я) или все, что видно по правам CRM. */
export type CallScope = 'mine' | 'all';

/** Воронка сделок для проверки «повторный клиент». */
export interface CallFunnelDto {
  id: number;
  name: string;
}

/** Клиент в окне звонков: последний подходящий звонок и сколько было звонков в периоде. */
export interface CallRowDto {
  /** Ключ клиента: контакт или номер. */
  clientKey: string;
  activityId: number;
  at: string;
  missed: boolean;
  phone: string | null;
  /** Входящих от клиента в периоде. */
  incomingCount: number;
  repeat: boolean;
  contact: { id: number; name: string | null } | null;
  /** Элемент CRM, к которому привязан звонок. */
  owner: { typeId: number; id: number; title: string | null };
  dealId: number | null;
  responsibleId: number | null;
}

/** `GET /api/dashboard/calls?kind=&from=&to=&scope=&funnel=` — клиенты выбранного вида. */
export interface CallListDto {
  kind: CallKind;
  items: CallRowDto[];
  /** Обрезано по лимиту выборки (очень много звонков за период). */
  truncated: boolean;
}

export type CallDirection = 'incoming' | 'outgoing';
/** Успешный; пропущен (входящий без ответа сотрудника); нет ответа (исходящий, клиент не взял трубку). */
export type CallStatus = 'success' | 'missed' | 'no_answer';
export const CALL_STATUS_LABELS: Record<CallStatus, string> = { success: 'Успешный', missed: 'Пропущен', no_answer: 'Нет ответа' };

/** Звонок в журнале дня. Номер линии портала без права `telephony` недоступен — вместо него сотрудник. */
export interface CallLogRowDto {
  activityId: number;
  at: string;
  durationSec: number;
  direction: CallDirection;
  status: CallStatus;
  /** Номер клиента: кто звонил (входящий) или куда звонили (исходящий). */
  clientPhone: string | null;
  /** Сотрудник: кто принял (входящий) или кто звонил (исходящий). */
  employee: { id: number; name: string | null } | null;
  contact: { id: number; name: string | null } | null;
  owner: { typeId: number; id: number; title: string | null };
}

/** `GET /api/dashboard/call-log?date=&scope=` — все звонки дня, новые сверху. */
export interface CallLogDto {
  date: string;
  scope: CallScope;
  items: CallLogRowDto[];
  truncated: boolean;
}


/** `PUT /api/openlines/chats/:chatId/reply-status` `{ needed }` — общая для всех отметка «ждёт ответа». */
export interface ChatReplyStatusDto {
  chatId: number;
  waitingReply: boolean;
  noReply: ChatSummary['noReply'];
}

/** Чат, требующий внимания: клиент написал последним, ответа нет. */
export interface AttentionChatDto {
  chatId: number;
  title: string;
  clientName: string | null;
  connector: string;
  lastMessageAt: string;
  /** Текст — только при включённом «сборе текстов». */
  preview: string;
  hasFiles: boolean;
  dealId: number | null;
  contactId: number | null;
  responsibleId: number | null;
}

/** `GET /api/openlines/chats/:chatId/channels` — чаты того же клиента в других открытых линиях. */
export interface ChatChannelDto {
  chatId: number;
  connector: string;
  title: string;
  lastMessageAt: string | null;
  waitingReply: boolean;
}

/**
 * Часть дашборда (`/api/dashboard?part=`): быстрая основа (чаты, брони, сегодня/завтра) и медленные
 * звонки и новые сделки — грузятся отдельно, чтобы экран не ждал самую долгую часть.
 */
export const DASHBOARD_PARTS = ['base', 'calls', 'deals'] as const;
export type DashboardPart = (typeof DASHBOARD_PARTS)[number];

/**
 * «Активность сотрудников» (дашборд, только администраторам приложения): что сотрудники групп
 * делали по часам дня — звонки, сообщения в чатах (свои и с телефона на смене), новые сделки,
 * брони и действия в приложении. Смена — по учёту рабочего времени Битрикс24 (timeman).
 */
export const ACTIVITY_KINDS = ['call', 'chat', 'phone', 'deal', 'booking', 'app'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  call: 'Звонки',
  chat: 'Сообщения в чатах',
  phone: 'Сообщения с телефона',
  deal: 'Новые сделки',
  booking: 'Брони',
  app: 'Действия в приложении',
};

export interface ActivityEventDto {
  at: string;
  kind: ActivityKind;
  text: string;
  /** Длительность звонка, секунд. */
  durationSec: number | null;
  dealId: number | null;
  chatId: number | null;
}

export interface EmployeeActivityDto {
  userId: number;
  name: string;
  /** Рабочий день по timeman в этот день; null — не начинал (или нет доступа к учёту времени). */
  shift: { start: string; end: string | null } | null;
  /** По часам с `fromHour` до `toHour` (не включая): число событий каждого вида. */
  hours: Record<ActivityKind, number>[];
  totals: Record<ActivityKind, number>;
  /** Минут разговоров (по началу и концу звонков). */
  callMinutes: number;
  /** Оценка минут работы в чатах: сообщения с перерывами до 10 минут — одна сессия. */
  chatMinutes: number;
  events: ActivityEventDto[];
}

export interface ActivityDayDto {
  date: string;
  timezone: string;
  fromHour: number;
  toHour: number;
  employees: EmployeeActivityDto[];
  /** Сообщения с телефона, которые некому приписать (никто не на смене). */
  unattributedPhone: number;
  notes: string[];
}
