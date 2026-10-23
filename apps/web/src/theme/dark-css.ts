/**
 * Тёмная тема из светлых стилей (решение владельца 2026-10-23: «тёмный режим для панели»).
 *
 * В `styles.css` сотни заданных напрямую цветов — переписывать каждое правило на токены долго и легко
 * пропустить. Поэтому при сборке (плагин в `vite.config.ts`) каждое правило с цветом получает
 * «двойника» под `:where(:root[data-theme='dark'])` — с той же специфичностью (`:where` её не
 * добавляет) и позже в каскаде, поэтому побеждает ровно там, где побеждало светлое правило. Цвета
 * переводятся по роли свойства: фон — в тёмную поверхность того же оттенка, текст — в светлый,
 * рамки — в приглушённые; насыщенные кнопки и бейджи остаются как есть. Токены (`var(--…)`) — из
 * `DARK_TOKENS`. Без зависимостей: разбор CSS — простой, под наш файл (правила, @media, @supports).
 */

export const DARK_ATTR = `[data-theme='dark']`;
const ROOT = `:where(:root${DARK_ATTR})`;

/** Токены тёмной темы (`:root` светлой — в начале `styles.css`). */
export const DARK_TOKENS = `:root${DARK_ATTR} {
  --bg: #0f131a;
  --surface: #171c26;
  --text: #e6e9ef;
  --muted: #9aa4b2;
  --line: rgba(255, 255, 255, 0.1);
  --primary: #2f7cf0;
  --primary2: #8b89f5;
  --danger: #f87171;
  --ok: #4ade80;
  --hover: #1f2633;
  --surface-2: #1b212c;
  --info-bg: #1a2742;
  --info-text: #9dbcff;
  --ok-bg: #12301f;
  --ok-text: #74e3a4;
  --warn-bg: #352610;
  --warn-text: #fcd38d;
  --neutral-bg: #262d39;
  color-scheme: dark;
}
`;

type Rgba = { r: number; g: number; b: number; a: number };
type Hsla = { h: number; s: number; l: number; a: number };
type Role = 'bg' | 'text' | 'border' | 'shadow';

const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;

/** Тёмные правила для всего файла стилей (без токенов). */
export function darkCss(css: string): string {
  return DARK_TOKENS + walk(stripComments(css)).join('');
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Правила верхнего уровня (или внутри @media): двойники; @keyframes, @font-face — пропуск. */
function walk(css: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    const close = matching(css, open);
    const body = css.slice(open + 1, close);
    i = close + 1;
    if (head.startsWith('@')) {
      if (/^@(media|supports)/.test(head)) {
        const inner = walk(body);
        if (inner.length) out.push(`${head} {\n${inner.join('')}}\n`);
      }
      continue;
    }
    const rule = twin(head, body);
    if (rule) out.push(rule);
  }
  return out;
}

function matching(css: string, open: number): number {
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) return j;
  }
  return css.length;
}

function twin(selector: string, body: string): string | null {
  const decls = body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const k = d.indexOf(':');
      return { prop: d.slice(0, k).trim().toLowerCase(), value: d.slice(k + 1).trim() };
    })
    .filter((d) => d.prop && d.value);
  // Токены `:root` — вручную в DARK_TOKENS.
  const isRoot = /^:root$/.test(selector.trim());
  const colored = decls.filter((d) => !(isRoot && d.prop.startsWith('--')) && roleOf(d.prop, d.value) && hasColor(d.value));
  if (!colored.length) return null;
  // Текст на светлом фоне того же правила (жёлтая плашка с тёмным текстом) — остаётся тёмным.
  const bg = decls.find((d) => d.prop === 'background' || d.prop === 'background-color');
  const bgDark = bg ? firstColor(bg.value, 'bg') : null;
  const keepText = !!bgDark && luminance(bgDark) > 0.5;
  const lines = colored
    .map(({ prop, value }) => {
      const role = roleOf(prop, value)!;
      if (role === 'text' && keepText) return null;
      const mapped = mapColors(value, role);
      return mapped === value ? null : `  ${prop}: ${mapped};`;
    })
    .filter(Boolean);
  if (!lines.length) return null;
  return `${scope(selector)} {\n${lines.join('\n')}\n}\n`;
}

function hasColor(v: string): boolean {
  COLOR.lastIndex = 0;
  return COLOR.test(v);
}

/** Каждый селектор списка — внутри тёмной темы; `html`/`:root` — сам корень. */
function scope(selector: string): string {
  return splitSelectors(selector)
    .map((s) => {
      const t = s.trim();
      if (/^(html|:root)\b/.test(t)) return t.replace(/^(html|:root)/, `$1:where(${DARK_ATTR})`);
      return `${ROOT} ${t}`;
    })
    .join(',\n');
}

/** Запятые верхнего уровня (не внутри `:is(…)`/`:not(…)`). */
function splitSelectors(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of selector) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.filter((s) => s.trim());
}

function roleOf(prop: string, value: string): Role | null {
  if (prop === 'color' || prop === 'fill' || prop === 'stroke' || prop === 'caret-color' || prop === 'text-decoration-color' || prop === 'accent-color')
    return 'text';
  if (prop === 'background' || prop === 'background-color' || prop === 'background-image') return 'bg';
  if (prop.startsWith('border') || prop.startsWith('outline') || prop === 'column-rule') return 'border';
  if (prop === 'box-shadow' || prop === 'text-shadow') return 'shadow';
  if (prop.startsWith('--')) {
    // Локальная переменная правила: по имени, иначе по яркости (светлое — фон, тёмное — текст).
    if (/bg|fill|surface|tint/.test(prop)) return 'bg';
    if (/text|fg|ink|color/.test(prop)) return 'text';
    if (/border|line/.test(prop)) return 'border';
    const c = firstColor(value, null);
    return c ? (luminance(c) > 0.5 ? 'bg' : 'text') : null;
  }
  return null;
}

function firstColor(value: string, role: Role | null): Rgba | null {
  COLOR.lastIndex = 0;
  const m = COLOR.exec(value);
  if (!m) return null;
  const c = parse(m[0]);
  return c && role ? map(c, role) : c;
}

function mapColors(value: string, role: Role): string {
  return value.replace(COLOR, (raw) => {
    const c = parse(raw);
    return c ? format(map(c, role)) : raw;
  });
}

/** Перевод одного цвета по роли (см. шапку). */
export function map(c: Rgba, role: Role): Rgba {
  const h = toHsl(c);
  const darkInk = h.l < 0.35;
  if (role === 'shadow') {
    // Тени тёмные — как есть; светлые «кольца» фокуса — тёмным оттенком.
    return h.l > 0.75 && h.a > 0.3 ? map(c, 'bg') : c;
  }
  // Полупрозрачная тёмная «вуаль» (наведение, линии) — светлая с той же прозрачностью.
  if (h.a < 0.35 && darkInk) return { r: 255, g: 255, b: 255, a: Math.min(1, h.a * 1.3) };
  if (role === 'text') {
    if (h.l >= 0.62) return c;
    return fromHsl({ h: h.h, s: Math.min(h.s, 0.85), l: 0.97 - h.l * 0.55, a: h.a });
  }
  // Насыщенный цвет средней яркости (кнопка, бейдж, полоса графика) — как есть; светлая поверхность или
  // пастельная плашка — в тёмную того же оттенка. Почти серые — с лёгкой синевой, как токены.
  const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
  const neutral = chroma < 0.06;
  const light = h.l >= 0.8 || (h.l >= 0.55 && chroma < 0.3);
  if (role === 'bg') {
    if (light) return fromHsl({ h: neutral ? 220 : h.h, s: neutral ? 0.18 : Math.min(h.s, 0.5), l: 0.11 + (1 - h.l) * 0.85, a: h.a });
    // Почти чёрные плашки (активная вкладка) — заметнее на тёмном фоне.
    if (h.l < 0.22 && h.s < 0.4 && h.a > 0.6) return fromHsl({ ...h, l: 0.3 });
    return c;
  }
  // border
  if (light) return fromHsl({ h: neutral ? 220 : h.h, s: neutral ? 0.14 : Math.min(h.s, 0.45), l: 0.2 + (1 - h.l) * 0.7, a: h.a });
  if (h.l < 0.25 && h.s < 0.4) return fromHsl({ ...h, l: 0.34 });
  return c;
}

export function parse(raw: string): Rgba | null {
  const s = raw.trim().toLowerCase();
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((x) => x + x).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
  }
  const m = /rgba?\(([^)]*)\)/.exec(s);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const ch = (x: string) => (x.endsWith('%') ? (parseFloat(x) * 255) / 100 : parseFloat(x));
  const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  const out = { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]), a };
  return [out.r, out.g, out.b, out.a].some((x) => Number.isNaN(x)) ? null : out;
}

export function format(c: Rgba): string {
  const r = Math.round(c.r);
  const g = Math.round(c.g);
  const b = Math.round(c.b);
  if (c.a < 1) return `rgba(${r}, ${g}, ${b}, ${Math.round(c.a * 1000) / 1000})`;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Относительная яркость WCAG (0 — чёрный, 1 — белый). */
export function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** Контраст WCAG двух непрозрачных цветов (1…21). */
export function contrast(a: Rgba, b: Rgba): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function toHsl({ r, g, b, a }: Rgba): Hsla {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l, a };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: h * 60, s, l, a };
}

function fromHsl({ h, s, l, a }: Hsla): Rgba {
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a };
}
