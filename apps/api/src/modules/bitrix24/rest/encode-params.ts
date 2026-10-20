/**
 * Кодирование параметров в query string в стиле PHP `http_build_query` — так их ждёт команда
 * `batch` (`cmd[key] = "method?filter[ID]=1&select[0]=ID"`). Ссылки вида `$result[cmd][ID]`
 * передаются как есть: их подставляет сам портал.
 */
export function encodeParams(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const add = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null) {
      pairs.push(`${encodeURIComponent(key)}=`);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => add(`${key}[${i}]`, item));
    } else if (value instanceof Date) {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value.toISOString())}`);
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) add(`${key}[${k}]`, v);
    } else {
      const raw = typeof value === 'boolean' ? (value ? 'Y' : 'N') : String(value);
      const encoded = raw.startsWith('$result[') ? raw : encodeURIComponent(raw);
      pairs.push(`${encodeURIComponent(key)}=${encoded}`);
    }
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return pairs.join('&');
}
