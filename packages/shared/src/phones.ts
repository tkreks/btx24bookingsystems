/** РФ по умолчанию: +7/7/8 и десятизначный номер — один клиент. Другие коды стран сохраняются. */
export function normalizeClientPhone(input: unknown): string | null {
  let digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 10) digits = `7${digits}`;
  else if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}
export function clientPhoneVariants(input: unknown): string[] {
  const digits = normalizeClientPhone(input);
  if (!digits) return [];
  return digits.length === 11 && digits.startsWith('7') ? [`+${digits}`, `8${digits.slice(1)}`, digits] : [`+${digits}`, digits];
}
/** Группа каналов: свой WhatsApp и провайдерский WhatsApp попадают в один фильтр. */
export function messageChannel(code: string): string {
  const groups: [RegExp,string][] = [[/whatsapp/i,'whatsapp'],[/telegram/i,'telegram'],[/viber/i,'viber'],[/(^|_)vk|vkgroup/i,'vkgroup'],[/avito/i,'avito'],[/instagram|fbinstagram/i,'instagram'],[/facebook/i,'facebook'],[/livechat/i,'livechat'],[/imessage/i,'imessage'],[/max/i,'max'],[/email|mail/i,'email']];
  return groups.find(([pattern]) => pattern.test(code))?.[1] ?? code;
}
