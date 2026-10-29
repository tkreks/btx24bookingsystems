/**
 * Служебный чат сделки (встройка сделки, 2026-10-29): у клиента нет мессенджеров — менеджер выбрал
 * «Без мессенджера». Чат только в приложении (в Битрикс24 не отправляется): сюда пишет автоматика
 * (ссылки на оплату, подтверждения), когда рабочего чата с клиентом нет, и сотрудники — заметки.
 */
export type ServiceChatSource = 'manager' | 'payment' | 'automation';

export interface ServiceChatMessageDto {
  id: string;
  source: ServiceChatSource;
  text: string;
  authorName: string | null;
  createdAt: string;
}

/** `GET /api/deals/:dealId/service-chat`; `chat: null` — служебного чата у сделки нет. */
export interface ServiceChatDto {
  dealId: number;
  chat: { createdAt: string; createdByUserId: number } | null;
  messages: ServiceChatMessageDto[];
}

/** Подпись источника сообщения служебного чата. */
export const SERVICE_CHAT_SOURCES: Record<ServiceChatSource, string> = {
  manager: 'Сотрудник',
  payment: 'Оплата',
  automation: 'Автоматика',
};
