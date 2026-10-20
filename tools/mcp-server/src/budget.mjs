// Ограничение размера ответов: агент получает компактный JSON, а не многокилобайтные дампы.
import { HARD_RESPONSE_CAP_BYTES } from './config.mjs';

const byteLen = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * Укладывает payload в budget байт: сначала укорачивает самый длинный массив верхнего уровня,
 * затем самую длинную строку. Всегда помечает `truncated: true`, если что-то отрезано.
 */
export function fitBudget(payload, budget) {
  const limit = Math.min(budget, HARD_RESPONSE_CAP_BYTES);
  if (byteLen(payload) <= limit) return payload;
  const out = { ...payload, truncated: true };
  for (let guard = 0; guard < 200 && byteLen(out) > limit; guard++) {
    const arrays = Object.entries(out).filter(([, v]) => Array.isArray(v) && v.length > 0);
    if (arrays.length) {
      const [key, arr] = arrays.sort((a, b) => byteLen(b[1]) - byteLen(a[1]))[0];
      out[key] = arr.slice(0, Math.max(0, Math.floor(arr.length * 0.7)));
      continue;
    }
    const strings = Object.entries(out).filter(([, v]) => typeof v === 'string' && v.length > 200);
    if (!strings.length) break;
    const [key, str] = strings.sort((a, b) => b[1].length - a[1].length)[0];
    out[key] = `${str.slice(0, Math.floor(str.length * 0.7))}\n…[truncated]`;
  }
  return out;
}
