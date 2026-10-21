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

export const DASHBOARD_PERIODS = ['today', '7d', '30d'] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

export interface DashboardDto {
  period: DashboardPeriod;
  /** Начало периода (UTC, ISO) в часовом поясе портала. */
  from: string;
  /** null — нет права на открытые линии ни в одной группе. */
  chats: { waitingReply: number; unreadMessages: number } | null;
  /** С кем общались в открытых линиях за период (уникальные элементы CRM). */
  contacts: { leads: number; contacts: number; deals: number; companies: number } | null;
  /** null — пока не считается: брони через приложение ещё не создаются и не отменяются. */
  bookings: { created: number | null; cancelled: number | null };
}
