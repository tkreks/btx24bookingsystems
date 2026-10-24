// Звонок клиента (решение владельца 2026-10-23): карточка в окне звонка Битрикс24 (встройка CALL_CARD)
// и в открытом приложении у ответившего сотрудника — клиент, сделки, брони, сообщения, «Создать бронь».
import type { ClientBookingsDto } from './bookings.js';
import type { ChatMessageDto, ChatSummary } from './openlines.js';

/** `GET /api/calls/card?phone=&entityType=&entityId=&callId=` */
export interface CallCardDto {
  /** Номер клиента (как пришёл от телефонии). */
  phone: string | null;
  contact: { id: number; name: string | null } | null;
  /** Брони, сделки в работе (с цветом и статусом), успешные сделки — как в шапке чата. */
  client: ClientBookingsDto | null;
  /** Сделка, которую предложить для брони: сделка звонка (новая) или самая новая открытая. */
  suggestedDealId: number | null;
  timeline: ClientTimelineDto;
  /** Чаты клиента в открытых линиях (по номеру); нет права — пусто. */
  chats: ChatSummary[];
  /** Последние сообщения самого свежего чата (по возрастанию времени). */
  messages: { chatId: number; title: string; items: ChatMessageDto[] } | null;
}

/** `GET /api/calls/active` — звонки, на которые сейчас отвечает сотрудник (по событиям телефонии). */
export interface ActiveCallDto {
  callId: string;
  phone: string | null;
  /** 1 исходящий, 2 входящий, 3 с переадресацией, 4 обратный, 5 инфозвонок. */
  callType: number | null;
  answeredAt: string;
}


/** Событие клиента: время события, а не время чтения карточки. */
export interface ClientTimelineEvent {
  category?: import('./audit-classification.js').ActionLogCategory;
  severity?: import('./audit-classification.js').ActionLogSeverity;

  id: string;
  at: string;
  kind: 'message' | 'call' | 'deal' | 'booking' | 'payment' | 'invoice' | 'activity';
  title: string;
  text: string | null;
  dealId?: number;
  chatId?: number;
  messageId?: number;
  direction?: 'incoming' | 'outgoing';
  actorId?: number;
  actorName?: string;
  amount?: number;
  currency?: string;
}

export interface ClientTimelineDto {
  events: ClientTimelineEvent[];
  /** Недоступные источники и ограничения объёма истории. */
  notes: string[];
}
