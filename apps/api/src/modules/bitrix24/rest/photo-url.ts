/**
 * URL картинки из ответа Битрикс24 (PERSONAL_PHOTO, avatar): абсолютный — как есть, путь портала —
 * с его доменом; пусто и заглушки — null.
 */
export function photoUrl(v: unknown, domain: string): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.includes('/blank.') || s.length > 1000) return null;
  if (/^https:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('/')) return `https://${domain}${s}`;
  return null;
}
