import type { DealStatusDto } from './deal-status.js';
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
  /** Аватар клиента из последней доступной сводки чата. */
  clientAvatar?: string | null;
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
  /** «!» — общая отметка «важно» (кто и когда); пропадает, когда после неё в чат пишет сотрудник. */
  flag?: { byName: string | null; at: string } | null;
  /** Пользователь — участник чата (иначе сначала «Присоединиться»). */
  joined: boolean;
  sessionClosed: boolean;
  crm: ChatCrmLinks;
  /** Телефоны клиента из привязанных контакта / лида / компании (для поиска; не сохраняются). */
  phones: string[];
  /** Непрочитанных сообщений у меня (счётчик мессенджера); «Не требует ответа» — 0. */
  unread: number;
  /** Папка, где лежит чат (моя или глобальная коллеги); null — в общем списке. */
  folderId: string | null;
  /** В моём избранном (★). */
  favorite: boolean;
}

/** Псевдопапка «★ Избранное» в списке папок и `?folder=` списка чатов. */
export const FAVORITES_FOLDER = 'favorites';

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
  /** Глобальная: видят все с доступом к её чатам, «не обращать внимания» — у всех. */
  global: boolean;
  /** Моя папка (меняю я); чужая глобальная — только смотреть. */
  mine: boolean;
  /** `favorites` — псевдопапка «★ Избранное» (`id = FAVORITES_FOLDER`). */
  kind?: 'folder' | 'favorites';
}

export interface ChatListDto {
  /** Каналы всех доступных чатов (до пагинации/фильтра по каналу). */
  channels?: string[];
  /** Итоги по всему отбору, до пагинации и раскрытия папок. */
  /** `booked` — клиенты с активной бронью на сегодня; `payment` — ждём оплату (счёт выставлен, не оплачен). */
  counts?: { all: number; waiting: number; mine: number; booked?: number; payment?: number };
  userId?: number;
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
  /** Сколько раз я вставлял шаблон в чат за 30 дней (сортировка окна «Шаблоны»). */
  uses30d?: number;
}

export type MessageTemplatePurpose = 'chat' | 'payment' | 'auto';

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
  deal: {
    title: string;
    opportunity: number | null;
    currency: string | null;
    client: string | null;
    /** Статус сделки (канбан + брони); null — не посчитан. */
    status?: DealStatusDto | null;
  } | null;
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
  bookingDays: { from?: string; to?: string; nextDate?: string; today: number; tomorrow: number; todayItems: DashboardBookingRow[]; tomorrowItems: DashboardBookingRow[] };
  /** Клиенты по видам звонков за период; null — нет доступа к делам CRM. */
  calls: Record<CallKind, number> | null;
  /** Все звонки за период (входящие и исходящие, по `callsScope`); null — нет доступа к делам CRM. */
  callsTotal: number | null;
  /**
   * Новые сделки — созданные за период в воронках групп пользователя (по `callsScope`: мои — где я
   * ответственный), и сколько из них от повторных клиентов. null — нет доступа к сделкам CRM.
   */
  newDeals: { total: number; repeat: number; items: DashboardNewDeal[]; truncated: boolean } | null;
  /**
   * Сделки с оплатой за период — по которым за период выросла «Сумма внесённых оплат» (учёт worker'а,
   * `DealPayment`), той же выборки по воронкам и «Мои»; у сделок есть `payment`. null — нет доступа к сделкам.
   */
  paidDeals?: { total: number; items: DashboardNewDeal[] } | null;
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
  /** Покупка сертификата (поле «Тип сделки»): брони у неё и не бывает. */
  certificate: boolean;
  /** Источник сделки (SOURCE_ID и название из справочника CRM); null — не указан. */
  source: { id: string; name: string } | null;
  /** Оплачена: счёт приложения оплачен или в сделке есть «Сумма внесённых оплат». */
  paid: boolean;
  /** Оплата за период (только в `paidDeals`): когда последняя и сколько поступило. */
  payment?: { at: string; amount: number };
  /** Бронь сделки (ближайшая активная из журнала): ресурсы и время; null — брони нет. */
  slot: { start: string; end: string; resources: string[] } | null;
  /** Статус сделки: В работе / Ожидание клиента / Завершена / Провалена (канбан + брони). */
  status?: DealStatusDto | null;
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
  /** Статус сделки звонка (если звонок привязан к сделке). */
  dealStatus?: DealStatusDto | null;
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
  /** Последняя созданная доступная сделка клиента (независимо от даты звонка). */
  latestDealId?: number | null;
  /** Доступный чат клиента с самой свежей активностью. */
  latestChatId?: number | null;
  direction: CallDirection;
  status: CallStatus;
  /** Номер клиента: кто звонил (входящий) или куда звонили (исходящий). */
  clientPhone: string | null;
  /** Номер линии из статистики телефонии, если доступен; reg/SIP ID не показываем как телефон. */
  portalPhone?: string | null;
  /** Последний пропущенный без последующего успешного разговора или диалога в чате; как показатель «Упущенные». */
  lost?: boolean;
  /** Сотрудник: кто принял (входящий) или кто звонил (исходящий); фото — аватарка в Битрикс24. */
  employee: { id: number; name: string | null; photo?: string | null } | null;
  contact: { id: number; name: string | null; photo?: string | null } | null;
  /** Аватар клиента из последнего доступного чата (как в блоке ожиданий). */
  clientAvatar?: string | null;
  owner: { typeId: number; id: number; title: string | null };
  /** Звонок привязан к сделке — её статус (канбан + брони). */
  dealStatus?: DealStatusDto | null;
}

/** `GET /api/dashboard/recent-calls?scope=&from=&to=` — последние звонки периода (до 50), новые сверху. */
export interface RecentCallsDto {
  scope: CallScope;
  from?: string;
  to?: string;
  items: CallLogRowDto[];
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
  /** Личный счётчик непрочитанных сотрудника, как на странице чатов. */
  unread: number;
  title: string;
  clientName: string | null;
  /** Аватарка клиента в открытой линии (URL); null — нет. */
  clientAvatar: string | null;
  connector: string;
  lastMessageAt: string;
  /** Текст — только при включённом «сборе текстов». */
  preview: string;
  hasFiles: boolean;
  dealId: number | null;
  contactId: number | null;
  responsibleId: number | null;
  /** «!» у чата (общая отметка) — на дашборде подсвечивается и стоит первым. */
  flag?: { byName: string | null; at: string } | null;
}

/** `PUT /api/openlines/chats/:chatId/flag {on}` */
export interface ChatFlagDto {
  chatId: number;
  flag: { byName: string | null; at: string } | null;
}

/** `GET /api/openlines/chats/:chatId/channels` — чаты того же клиента в других открытых линиях. */
export interface ChatChannelDto {
  chatId: number;
  connector: string;
  title: string;
  lastMessageAt: string | null;
  waitingReply: boolean;
  /** Для окна «Чаты клиента» (как «Последние сообщения» дашборда): клиент, аватар, превью, непрочитанные, сделка. */
  clientName?: string | null;
  clientAvatar?: string | null;
  preview?: string;
  hasFiles?: boolean;
  unread?: number;
  dealId?: number | null;
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
  id?: string;
  messageId?: number;
  direction?: 'incoming' | 'outgoing';
  action?: string;
  details?: unknown;

  at: string;
  kind: ActivityKind;
  text: string;
  /** Длительность звонка, секунд. */
  durationSec: number | null;
  dealId: number | null;
  chatId: number | null;
}

export interface EmployeeActivityDto {
  /** 0 — строка «Совместное использование» (`sharedBy`). */
  userId: number;
  name: string;
  /** Аватарка сотрудника в Битрикс24 (URL); null — нет. */
  photo: string | null;
  /**
   * Строка «Совместное использование»: сообщения с телефона, когда смена была открыта сразу у
   * нескольких сотрудников, — приписать одному нельзя. Имена тех, чьи смены совпали.
   */
  sharedBy?: string[];
  /** Рабочий день по timeman, захвативший этот день (мог начаться раньше); null — не было (или нет доступа к учёту времени). */
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

/** День дашборда руководителя (по времени портала). */
export interface HeadDayDto {
  date: string;
  /** Новые сделки (созданы в этот день, воронки всех групп). */
  newDeals: number;
  /** Сколько из них уже с бронью (журнал приложения). */
  bookedDeals: number;
  /** Брони по новым сделкам (все сделанные, в т.ч. потом снятые). */
  bookings: number;
  /** Новые сделки повторных клиентов (у контакта раньше была состоявшаяся сделка — бронь прошла). */
  repeat: number;
  /** Все звонки дня (входящие и исходящие). */
  calls: number;
  /** Пропущенные входящие. */
  missed: number;
  /** Упущенные клиенты: после пропущенного нет успешного разговора и диалога с сотрудником в чате. */
  lost: number;
}

export type HeadTotalsDto = Omit<HeadDayDto, 'date'> & { incoming: number; outgoing: number };

/**
 * `GET /api/head-dashboard?from&to` — дашборд руководителя (⚙ → «Приложение» → «Руководители»): по дням
 * и итого. null — нет доступа к сделкам / звонкам CRM у руководителя.
 */
export interface HeadDashboardDto {
  from: string;
  to: string;
  timezone: string;
  days: HeadDayDto[];
  totals: HeadTotalsDto;
  /** Предыдущий период той же длины (сегодня — вчера; 31 день — 31 день перед ним) — для сравнения. */
  previous: { from: string; to: string; totals: HeadTotalsDto };
  deals: boolean;
  calls: boolean;
  notes: string[];
}

/** Личный журнал: userId всегда из аутентификации, права администратора его не расширяют. */
export interface MyActivityDto {
  userId: number;
  from: string;
  to: string;
  events: import('./calls.js').ClientTimelineEvent[];
  notes: string[];
}
