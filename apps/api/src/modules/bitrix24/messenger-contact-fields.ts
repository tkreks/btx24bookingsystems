/** Собственные поля приложения: один реестр для синхронизации и границ записи в CRM. */
export const MESSENGER_CONTACT_FIELDS = [
  { kind: 'telegram', code: 'UF_CRM_BTX24_TELEGRAM_ID', name: 'Telegram', xmlId: 'btx24.telegram.id', multiple: 'N' },
  { kind: 'whatsapp', code: 'UF_CRM_BTX24_WHATSAPP_ID', name: 'WhatsApp', xmlId: 'btx24.whatsapp.id', multiple: 'Y' },
  { kind: 'max', code: 'UF_CRM_BTX24_MAX_ID', name: 'MAX', xmlId: 'btx24.max.id', multiple: 'N' },
] as const;

export const contactFieldOf = (kind: string) => MESSENGER_CONTACT_FIELDS.find(f => f.kind === kind);
export function messengerIdentityOf(kind: string, chatId: string): string | null {
  if (!contactFieldOf(kind)) return null;
  // WA: номер и скрытый LID — разные пространства ID, суффикс сохраняем.
  if (kind === 'whatsapp') return /^\d{1,20}@(lid|c\.us)$/.test(chatId) ? chatId : null;
  return /^(\d{1,20})@lid$/.exec(chatId)?.[1] ?? null;
}
export function contactFieldValues(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean);
}
export function contactFieldTarget(kind: string, value: unknown): string | null {
  for (const id of contactFieldValues(value)) {
    const chatId = kind === 'whatsapp' ? id : `${id}@lid`;
    if (messengerIdentityOf(kind, chatId)) return chatId;
  }
  return null;
}
