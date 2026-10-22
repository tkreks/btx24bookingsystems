/**
 * Формулы полей сделки в настройках группы (решение владельца 2026-10-22): «50% от суммы заказа»
 * записывается как `{OPPORTUNITY} * 50%`. Разрешены числа (точка или запятая), ссылки на поля
 * `{КОД}`, `+ - * /`, скобки и `%` после числа или скобки (= делить на 100). Без `eval`.
 */

type Token = { t: 'num'; v: number } | { t: 'ref'; v: string } | { t: 'op'; v: '+' | '-' | '*' | '/' | '%' | '(' | ')' };

const REF = /^\{([A-Z0-9_]+)\}/i;
const NUM = /^\d+(?:[.,]\d+)?/;

function tokenize(expr: string): Token[] {
  const out: Token[] = [];
  let s = expr.trim().replace(/^=/, '').replace(/[×х]/g, '*').replace(/÷/g, '/');
  while (s.length) {
    const ws = /^\s+/.exec(s);
    if (ws) {
      s = s.slice(ws[0].length);
      continue;
    }
    const r = REF.exec(s);
    if (r) {
      out.push({ t: 'ref', v: r[1].toUpperCase() });
      s = s.slice(r[0].length);
      continue;
    }
    const n = NUM.exec(s);
    if (n) {
      out.push({ t: 'num', v: Number(n[0].replace(',', '.')) });
      s = s.slice(n[0].length);
      continue;
    }
    const c = s[0];
    if ('+-*/%()'.includes(c)) {
      out.push({ t: 'op', v: c as '+' });
      s = s.slice(1);
      continue;
    }
    throw new Error(`Непонятный символ «${c}»`);
  }
  if (!out.length) throw new Error('Пустая формула');
  return out;
}

/** Разбор по приоритетам: expr = term (± term)*, term = factor (×÷ factor)*, factor = unary %*. */
function parse(tokens: Token[], value: (code: string) => number | null): number | null {
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expr = (): number | null => {
    let a = term();
    while (isOp('+') || isOp('-')) {
      const op = tokens[i++].v;
      const b = term();
      a = a === null || b === null ? null : op === '+' ? a + b : a - b;
    }
    return a;
  };
  const term = (): number | null => {
    let a = factor();
    while (isOp('*') || isOp('/')) {
      const op = tokens[i++].v;
      const b = factor();
      a = a === null || b === null ? null : op === '*' ? a * b : b === 0 ? null : a / b;
    }
    return a;
  };
  const factor = (): number | null => {
    if (isOp('-')) {
      i++;
      const v = factor();
      return v === null ? null : -v;
    }
    let v: number | null;
    const tk = tokens[i++];
    if (!tk) throw new Error('Формула обрывается');
    if (tk.t === 'num') v = tk.v;
    else if (tk.t === 'ref') v = value(tk.v);
    else if (tk.v === '(') {
      v = expr();
      if (!isOp(')')) throw new Error('Не хватает «)»');
      i++;
    } else throw new Error(`Лишний знак «${tk.v}»`);
    while (isOp('%')) {
      i++;
      if (v !== null) v = v / 100;
    }
    return v;
  };
  const result = expr();
  if (i < tokens.length) throw new Error(`Лишнее в конце формулы: «${(tokens[i] as { v: unknown }).v}»`);
  return result;
}

/** Коды полей, на которые ссылается формула. */
export function formulaRefs(expr: string): string[] {
  try {
    return [...new Set(tokenize(expr).flatMap((t) => (t.t === 'ref' ? [t.v] : [])))];
  } catch {
    return [];
  }
}

/** Ошибка формулы для настроек (null — формула правильная); `codes` — какие поля можно брать. */
export function checkFormula(expr: string, codes?: readonly string[]): string | null {
  try {
    const tokens = tokenize(expr);
    parse(tokens, () => 1);
    if (codes) {
      const unknown = tokens.find((t) => t.t === 'ref' && !codes.includes(t.v));
      if (unknown) return `Поля {${unknown.v}} нет среди полей группы`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Число из поля формы: «45 000,5» → 45000.5; пусто или не число — null. */
export function formNumber(v: string | undefined): number | null {
  const s = (v ?? '').replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Значение формулы по значениям формы (строки полей ввода). Не хватает значения поля или деление
 * на ноль — null (поле остаётся как есть). Результат — до копеек.
 */
export function evalFormula(expr: string, values: Record<string, string | undefined>): number | null {
  try {
    const v = parse(tokenize(expr), (code) => formNumber(values[code]));
    return v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
  } catch {
    return null;
  }
}
