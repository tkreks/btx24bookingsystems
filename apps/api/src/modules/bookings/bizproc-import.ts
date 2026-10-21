import { PROGRAM_FROM_KEYWORD, type BookingTypeRule, type ClientMessageStep } from '@btx24/shared';

/**
 * Перенос из БП «изменение полей сделки и отправка сообщения клиенту» (на admiral-club — 270,
 * разбор: docs/prototype/bp-270-confirmation.md) в правила приложения: типы брони по товарам,
 * значение поля «Тип бронирования», программа и цепочка сообщений в открытую линию.
 * Комментарии в сделку и уведомления сотрудникам не переносятся — клиенту уходит только то, что
 * БП отправлял в открытую линию (решение владельца 2026-10-21).
 */

interface Activity {
  Type?: string;
  Name?: string;
  Properties?: Record<string, unknown>;
  Children?: Activity[];
}

/** Поле сделки «Тип бронирования» в БП (у других порталов может отличаться — тогда пусто). */
const DEAL_TYPE_FIELD = 'UF_CRM_1754995195231';

/** Выражения БП → переменные шаблонов приложения. */
const VARIABLES: [RegExp, string][] = [
  [/\{=Document:CONTACT\.NAME\}/g, '{client_name}'],
  [/\{=Document:UF_CRM_1754843339886\}/g, '{date_start}'],
  [/\{=Document:UF_CRM_1754843349378\}/g, '{time_start}'],
  [/\{=Document:UF_CRM_1754843362814\}/g, '{date_end}'],
  [/\{=Document:UF_CRM_1754843387505\}/g, '{time_end}'],
  [/\{=Variable:programm(?: > printable)?\}/g, '{program}'],
  [/\{=Document:UF_CRM_1754826067667\}/g, '{guests}'],
  [/\{=Document:UF_CRM_1754996940869\}/g, '{house}'],
  [/\{=Document:OPPORTUNITY\}/g, '{amount}'],
];

export function convertText(text: string): string {
  return VARIABLES.reduce((t, [re, v]) => t.replace(re, v), text);
}

/** Условие ветки: свойство-массив вида [[переменная, оператор, значение, связка], …]. */
function conditions(a: Activity): [string, string, string][] {
  for (const v of Object.values(a.Properties ?? {})) {
    if (Array.isArray(v) && v.length && v.every((c) => Array.isArray(c) && c.length >= 3))
      return v.map((c) => [String(c[0]), String(c[1]), String(c[2])]);
  }
  return [];
}

function walk(a: Activity | Activity[] | undefined, f: (x: Activity) => void): void {
  if (!a) return;
  if (Array.isArray(a)) return a.forEach((x) => walk(x, f));
  f(a);
  walk(a.Children, f);
}

const props = (a: Activity) => a.Properties ?? {};
const branches = (a: Activity) => (a.Children ?? []).filter((c) => c.Type === 'IfElseBranchActivity');

/** `template` — поле TEMPLATE из `bizproc.workflow.template.list` (дерево действий). */
export function rulesFromBizproc(template: unknown): BookingTypeRule[] {
  const t = template as Activity | Activity[] | null;
  const root = Array.isArray(t) ? t[0] : t;
  const ifs = (root?.Children ?? []).filter((c) => c.Type === 'IfElseActivity');
  const [detect, send] = [ifs[0], ifs[1]];
  if (!detect) return [];

  // Ветки отправки: «dealtype = X» → шаги в открытую линию.
  const messages = new Map<string, ClientMessageStep[]>();
  for (const b of send ? branches(send) : []) {
    const cond = conditions(b).find(([v, op]) => v === 'dealtype' && op === '=');
    if (!cond) continue;
    const steps: ClientMessageStep[] = [];
    walk(b.Children, (x) => {
      const p = props(x);
      if (typeof p.MessageText !== 'string' || !('AttachmentType' in p)) return;
      const files =
        p.AttachmentType === 'disk' && Array.isArray(p.Attachment)
          ? p.Attachment.map(Number).filter((id) => Number.isInteger(id) && id > 0).map((id) => ({ id, name: `Файл Диска #${id}` }))
          : [];
      const text = convertText(p.MessageText).trim();
      if (text || files.length) steps.push({ text, files });
    });
    messages.set(cond[2], steps);
  }

  const rules: BookingTypeRule[] = [];
  for (const b of branches(detect)) {
    const keywords = conditions(b)
      .filter(([v, op]) => v === 'tovary' && op === 'contain')
      .map(([, , value]) => value.trim())
      .filter(Boolean);
    if (!keywords.length) continue; // «Не определено» (truecondition) — не тип
    let type = '';
    let program = '';
    let dealTypeValue = '';
    for (const x of b.Children ?? []) {
      const p = props(x);
      const vars = p.VariableValue as Record<string, string> | undefined;
      if (vars?.dealtype) type = vars.dealtype;
      if (vars?.programm) program = vars.programm;
      const fields = p.FieldValue as Record<string, unknown> | undefined;
      if (fields && DEAL_TYPE_FIELD in fields) dealTypeValue = String(fields[DEAL_TYPE_FIELD] ?? '');
      // Вложенный выбор программы по товарам → программа = совпавшее ключевое слово.
      if (x.Type === 'IfElseActivity' && branches(x).some((br) => conditions(br).some(([v]) => v === 'tovary'))) program = PROGRAM_FROM_KEYWORD;
    }
    const title = type || String(props(b).Title ?? keywords[0]);
    rules.push({
      id: slug(title, rules.length),
      title,
      keywords,
      dealTypeValue,
      program,
      confirmation: messages.get(type) ?? [],
    });
  }
  return rules;
}

function slug(title: string, i: number): string {
  const map: Record<string, string> = { Программы: 'programs', Суточная: 'daily', Почасовая: 'hourly', Теремок: 'teremok', Сертификат: 'certificate' };
  return map[title] ?? `type${i + 1}`;
}
