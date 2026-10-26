// Шаблонизатор сообщений клиенту. Понимает три записи переменных:
//   {{Дата начала визита}}, {{Сумма}}, {{Контакт: Имя}} — как в Битрикс24 (поле сделки/контакта по названию);
//   {=Variable:programm > printable}, {=Document:UF_CRM_…}, {=Document:CONTACT.NAME} — как в БП;
//   {client_name}, {link}, {prepayment}… — короткие переменные приложения (TEMPLATE_VARIABLES).
// Неизвестная переменная остаётся в тексте как есть — её видно в проверке шаблона.

export interface MessageContext {
  /** Короткие переменные приложения: client_name, link, prepayment… */
  vars: Record<string, string | number | null | undefined>;
  /** Поля сделки: название (в нижнем регистре) → значение для клиента. */
  dealByTitle: Record<string, string>;
  /** Поля сделки: код (UF_CRM_…, OPPORTUNITY…) → значение для клиента. */
  dealByCode: Record<string, string>;
  /** Поля контакта: название в нижнем регистре и код → значение. */
  contact: Record<string, string>;
  /** Переменные БП: programm, dealtype… (`{=Variable:…}`). */
  variables: Record<string, string>;
}

export const emptyMessageContext = (): MessageContext => ({ vars: {}, dealByTitle: {}, dealByCode: {}, contact: {}, variables: {} });

const norm = (s: string) => s.trim().toLocaleLowerCase('ru').replace(/\s+/g, ' ');
const present = (v: unknown): v is string | number => v !== undefined && v !== null && String(v) !== '';

/** Имена переменных приложения, которым соответствуют названия в `{{…}}` (для удобства). */
const TITLE_ALIASES: Record<string, string> = {
  'имя клиента': 'client_name',
  'ссылка на оплату': 'link',
  'сумма предоплаты': 'prepayment',
  'сумма к оплате': 'prepayment',
  'оплатить до': 'deadline',
  'минут на оплату': 'minutes',
  программа: 'program',
  'дом для клиента': 'house',
};

function bitrixToken(inner: string, ctx: MessageContext): string | null {
  // {{Контакт: Имя}}
  const m = /^(контакт|клиент)\s*:\s*(.+)$/i.exec(inner);
  if (m) {
    const v = ctx.contact[norm(m[2])];
    return present(v) ? String(v) : null;
  }
  const key = norm(inner);
  const alias = TITLE_ALIASES[key];
  if (alias && present(ctx.vars[alias])) return String(ctx.vars[alias]);
  const d = ctx.dealByTitle[key];
  if (present(d)) return String(d);
  if (alias === 'program' && present(ctx.variables.programm)) return ctx.variables.programm;
  return null;
}

/** Переменные БП оплаты (тексты из БП портала, 2026-10-26) → переменные приложения. */
const BP_VARIABLE_ALIASES: Record<string, string> = {
  paymentlink_new: 'link',
  paymentlink: 'link',
  paymentsum_new: 'prepayment',
  paymentsum: 'prepayment',
};

function bpToken(kind: string, path: string, ctx: MessageContext): string | null {
  const name = path.trim();
  if (/^variable$/i.test(kind)) {
    const alias = BP_VARIABLE_ALIASES[name.toLowerCase()];
    if (alias && present(ctx.vars[alias])) return String(ctx.vars[alias]);
    const v = ctx.variables[name] ?? ctx.variables[name.toLowerCase()];
    return present(v) ? String(v) : null;
  }
  // Document: CONTACT.NAME → поле контакта; иначе поле сделки по коду.
  const c = /^CONTACT\.(.+)$/i.exec(name);
  if (c) {
    const v = ctx.contact[c[1].toUpperCase()] ?? ctx.contact[norm(c[1])];
    return present(v) ? String(v) : null;
  }
  const v = ctx.dealByCode[name.toUpperCase()] ?? ctx.dealByCode[name];
  return present(v) ? String(v) : null;
}

/** Подставить все переменные; не найденные остаются как есть. */
export function renderMessage(text: string, ctx: MessageContext): string {
  return text
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, inner: string) => bitrixToken(inner, ctx) ?? m)
    .replace(/\{=\s*(Variable|Document)\s*:\s*([^}>]+?)\s*(?:>\s*[a-z]+\s*)?\}/gi, (m, kind: string, path: string) => bpToken(kind, path, ctx) ?? m)
    .replace(/\{([a-z_]+)\}/g, (m, name: string) => (present(ctx.vars[name]) ? String(ctx.vars[name]) : m));
}

/** Переменные, которые остались не подставленными (для проверки шаблона). */
export function unresolvedTokens(rendered: string): string[] {
  const out = new Set<string>();
  for (const re of [/\{\{[^{}]+\}\}/g, /\{=[^}]+\}/g, /\{[a-z_]+\}/g]) for (const m of rendered.matchAll(re)) out.add(m[0]);
  return [...out];
}

/** Есть ли в тексте переменные — чтобы не собирать данные сделки зря. */
export function hasTokens(text: string): boolean {
  return /\{\{[^{}]+\}\}|\{=[^}]+\}|\{[a-z_]+\}/.test(text);
}

/** `GET/POST /api/templates/preview` — текст на данных сделки. */
export interface TemplatePreviewDto {
  text: string;
  unresolved: string[];
}

/** `GET /api/openlines/templates/variables` — что можно подставлять (подсказка в редакторе). */
export interface TemplateVariablesDto {
  /** Поля сделки портала: `{{Название}}`. */
  deal: string[];
  /** Поля контакта: `{{Контакт: Название}}`. */
  contact: string[];
  /** Переменные приложения и БП: запись → описание. */
  app: { token: string; label: string }[];
}


/** Есть ли в тексте ссылка на оплату: {link}, {{Ссылка на оплату}} или переменная БП paymentlink. */
export function hasPaymentLinkToken(text: string): boolean {
  return /\{link\}|\{\{\s*ссылка на оплату\s*\}\}|\{=\s*Variable\s*:\s*paymentlink(_new)?\b/i.test(text);
}
