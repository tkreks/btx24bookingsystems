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
  steps: (TemplateStepDto & { files: StoredFileDto[] })[];
  updatedAt: string;
}

export interface SaveTemplateDto {
  name: string;
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
  /** Звонки за период (телефония Битрикс24); null — нет доступа к делам CRM. */
  calls: Record<CallKind, number> | null;
  callsScope: CallScope;
  /** Свои брони из журнала приложения: созданные за период (клиентские — со сделками) и отменённые за период. */
  bookings: { created: number; cancelled: number; deals: DashboardBookingRow[]; cancelledList: DashboardBookingRow[] };
}

/** Звонки на дашборде: входящие, отвеченные, пропущенные, упущенные (не перезвонили). */
export const CALL_KINDS = ['incoming', 'answered', 'missed', 'lost'] as const;
export type CallKind = (typeof CALL_KINDS)[number];
export const CALL_KIND_LABELS: Record<CallKind, string> = {
  incoming: 'Входящие',
  answered: 'Отвеченные',
  missed: 'Пропущенные',
  lost: 'Упущенные',
};

/** Чьи звонки: свои (ответственный — я) или все, что видно по правам CRM. */
export type CallScope = 'mine' | 'all';

export interface CallRowDto {
  activityId: number;
  at: string;
  missed: boolean;
  phone: string | null;
  /** Элемент CRM, к которому привязан звонок. */
  owner: { typeId: number; id: number; title: string | null };
  /** Сделка звонка (если звонок привязан к сделке). */
  dealId: number | null;
  responsibleId: number | null;
}

/** `GET /api/dashboard/calls?kind=&from=&to=&scope=` — звонки выбранного вида для окна со сделками. */
export interface CallListDto {
  kind: CallKind;
  items: CallRowDto[];
  /** Обрезано по лимиту выборки (очень много звонков за период). */
  truncated: boolean;
}
