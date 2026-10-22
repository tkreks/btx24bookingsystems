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
  /** Канал: whatsapp, telegram, livechat, … (из `entity_id` чата). */
  connector: string;
  responsibleId: number | null;
  lastMessage: { id: number; date: string; author: MessageAuthorKind; preview: string; hasFiles: boolean } | null;
  /** Последнее значимое сообщение — от клиента, а сессия открыта: ждёт ответа. */
  waitingReply: boolean;
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
  /** Мой шаблон (я автор). */
  mine: boolean;
  /** Можно менять: свой личный или общий для администратора приложения. */
  canEdit: boolean;
  steps: (TemplateStepDto & { files: StoredFileDto[] })[];
  updatedAt: string;
}

export interface SaveTemplateDto {
  name: string;
  /** Общий шаблон — только администратор приложения. */
  shared?: boolean;
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
  deal: { title: string; opportunity: number | null; currency: string | null } | null;
  resources: string[];
  /** Начало и конец брони (UTC, ISO). */
  start: string;
  end: string;
  status: 'active' | 'cancelled';
  cancelReason: 'payment_timeout' | 'manual' | 'removed_in_bitrix' | null;
  createdAt: string;
  cancelledAt: string | null;
}

export interface DashboardDto {
  /** Период — дни `[from, to]` включительно (YYYY-MM-DD) в часовом поясе портала. */
  from: string;
  to: string;
  /** null — нет права на открытые линии ни в одной группе. Счётчики «сейчас», не за период. */
  chats: { waitingReply: number; unreadMessages: number } | null;
  /** С кем общались в открытых линиях за период (уникальные элементы CRM). */
  contacts: { leads: number; contacts: number; deals: number; companies: number } | null;
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
  /** Свои брони из журнала приложения: созданные за период (клиентские — со сделками) и отменённые за период. */
  bookings: { created: number; cancelled: number; deals: DashboardBookingRow[]; cancelledList: DashboardBookingRow[] };
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

