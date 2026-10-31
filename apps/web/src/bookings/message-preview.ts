// Предпросмотр сообщения клиенту без переменных (решение владельца 2026-10-31): вместо {link} и
// {deadline} показываются подставленные значения — место ссылки и срок оплаты. Отправляется при этом
// исходный текст с переменными: ссылку и срок знает только сервер в момент отправки.

/** Кусок предпросмотра: обычный текст, место ссылки на оплату или срок оплаты. */
export type PreviewPart = { kind: 'text' | 'link' | 'deadline'; text: string };

/** Все записи ссылки ({link}, {{Ссылка на оплату}}, {{СсылкаНаОплату}}, БП paymentlink) и срока ({deadline}, {{Оплатить до}}). */
const TOKEN_RE = /\{link\}|\{\{\s*ссылка\s*на\s*оплату\s*\}\}|\{\{\s*СсылкаНаОплату\s*\}\}|\{=\s*Variable\s*:\s*paymentlink(?:_new)?\s*(?:>\s*[a-z]+\s*)?\}|\{deadline\}|\{\{\s*оплатить\s*до\s*\}\}/gi;

const isLinkToken = (t: string) => /link|ссылка/i.test(t);

/**
 * Разбить текст на куски для предпросмотра: переменные ссылки и срока — отдельными кусками с
 * подставленным значением. Записи ссылки нет — она добавляется последней строкой (так же поступает
 * сервер при отправке). `link` — настоящая ссылка, если уже известна; иначе подпись-заглушка.
 */
export function messagePreviewParts(text: string, opts: { deadlineText?: string; link?: string | null } = {}): PreviewPart[] {
  const linkText = opts.link || 'ссылка на оплату';
  const deadline = opts.deadlineText || 'срок оплаты';
  const parts: PreviewPart[] = [];
  let last = 0;
  let hasLink = false;
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index) });
    if (isLinkToken(m[0])) {
      hasLink = true;
      parts.push({ kind: 'link', text: linkText });
    } else parts.push({ kind: 'deadline', text: deadline });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  if (!hasLink && text.trim()) {
    parts.push({ kind: 'text', text: '\n' });
    parts.push({ kind: 'link', text: linkText });
  }
  return parts;
}

/** Срок оплаты для предпросмотра: «до ЧЧ:ММ ДД.ММ» через `minutes` минут от текущего момента (зона портала). */
export function deadlinePreview(minutes: number | null, timezone: string, now = Date.now()): string {
  if (!minutes || minutes <= 0) return '';
  const at = new Date(now + minutes * 60_000);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(at);
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: '2-digit', month: '2-digit' }).format(at);
  return `${time} ${date}`;
}
