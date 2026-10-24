import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, darkCss, DARK_TOKENS, luminance, map, parse } from './dark-css.js';

const source = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const c = (s: string) => parse(s)!;
const tokens = (css: string) => Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const lightTokens = tokens(source.slice(source.indexOf(':root'), source.indexOf('}', source.indexOf(':root'))));
const darkTokens = tokens(DARK_TOKENS);

describe('тёмная тема', () => {
  it('фон — тёмный того же оттенка, текст — светлый, насыщенные кнопки — как есть', () => {
    expect(luminance(map(c('#ffffff'), 'bg'))).toBeLessThan(0.03);
    expect(luminance(map(c('#ecfdf3'), 'bg'))).toBeLessThan(0.05);
    expect(luminance(map(c('#111827'), 'text'))).toBeGreaterThan(0.7);
    expect(map(c('#3b82f6'), 'bg')).toEqual(c('#3b82f6'));
    expect(map(c('#ffffff'), 'text')).toEqual(c('#ffffff'));
    // Линия-«вуаль» rgba(тёмный, 0.1) → светлая с той же прозрачностью.
    expect(map(c('rgba(17, 24, 39, 0.1)'), 'border')).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it('токены: текст, приглушённый текст, ссылки и цветные плашки читаются', () => {
    const t = (k: string) => c(darkTokens[k]);
    for (const bg of ['surface', 'bg', 'surface-2', 'hover']) {
      expect(contrast(t('text'), t(bg))).toBeGreaterThan(7);
      expect(contrast(t('muted'), t(bg))).toBeGreaterThan(4.5);
    }
    expect(contrast(t('primary'), t('surface'))).toBeGreaterThan(4.2);
    expect(contrast(c('#ffffff'), t('primary'))).toBeGreaterThan(3.5);
    for (const [bg, fg] of [
      ['info-bg', 'info-text'],
      ['ok-bg', 'ok-text'],
      ['warn-bg', 'warn-text'],
      ['neutral-bg', 'muted'],
    ])
      expect(contrast(t(fg), t(bg)), `${fg} на ${bg}`).toBeGreaterThan(4.5);
    // Те же токены есть в обеих темах.
    expect(Object.keys(darkTokens).sort()).toEqual(Object.keys(lightTokens).filter((k) => !k.startsWith('safe-') && k !== 'radius').sort());
  });

  it('статусы читаются в обеих темах и темнее похожих фонов строк', () => {
    for (const k of ['work', 'wait', 'arrived', 'done', 'fail']) {
      for (const t of [lightTokens, darkTokens]) expect(contrast(c(t[`status-${k}-text`]), c(t[`status-${k}-bg`])), k).toBeGreaterThan(4.5);
    }
    for (const [k, row] of [['work', '#eff8ff'], ['wait', '#fffaeb'], ['done', '#ecfdf3'], ['arrived', '#eff8ff'], ['fail', '#fef3f2']]) {
      expect(luminance(c(lightTokens[`status-${k}-bg`]))).toBeLessThan(luminance(c(row)));
      expect(luminance(c(darkTokens[`status-${k}-bg`]))).toBeLessThan(luminance(map(c(row), 'bg')));
    }
  });

  it('правила styles.css: фон и текст одного правила в тёмной теме не хуже светлой (или не ниже 4.5)', () => {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const color = (v: string, t: Record<string, string>) => {
      const m = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|var\(--[\w-]+\)|\bwhite\b/.exec(v);
      if (!m) return null;
      const ref = /var\(--([\w-]+)\)/.exec(m[0]);
      return parse(ref ? (t[ref[1]] ?? '') : m[0]);
    };
    const isVar = (v: string) => v.trim().startsWith('var(');
    const bad: string[] = [];
    for (const [, selector, body] of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const bg = /(?:^|;)\s*background(?:-color)?:\s*([^;]+)/.exec(body)?.[1];
      const fg = /(?:^|;)\s*color:\s*([^;]+)/.exec(body)?.[1];
      if (!bg || !fg) continue;
      const lb = color(bg, lightTokens);
      const lf = color(fg, lightTokens);
      if (!lb || !lf || lb.a < 0.9 || lf.a < 0.9) continue;
      const db = isVar(bg) ? color(bg, darkTokens)! : map(lb, 'bg');
      // Тёмный текст на светлом фоне правила остаётся тёмным (см. `twin`).
      const df = isVar(fg) ? color(fg, darkTokens)! : luminance(db) > 0.5 ? lf : map(lf, 'text');
      const need = Math.min(contrast(lb, lf), 4.5) - 0.05;
      if (contrast(db, df) < need) bad.push(`${selector.trim()}: ${contrast(db, df).toFixed(2)} < ${need.toFixed(2)}`);
    }
    expect(bad).toEqual([]);
  });

  it('двойники — без добавочной специфичности (:where) и с теми же @media', () => {
    const out = darkCss(source);
    expect(out).toContain(":where(:root[data-theme='dark']) body");
    expect(out).not.toMatch(/(^|\n):root\[data-theme='dark'\] \./);
    expect(out).not.toContain('@keyframes');
    expect(darkCss('@media (max-width: 760px) { .a { color: #111827; } .b { gap: 4px; } } @keyframes k { to { color: #000; } }')).toContain(
      "@media (max-width: 760px) {\n:where(:root[data-theme='dark']) .a {",
    );
  });
});
