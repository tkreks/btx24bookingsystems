import { useEffect, useId, useRef, useState } from 'react';
import {
  DUPLICATE_REASON_LABELS,
  MERGE_MAX_CONTACTS,
  type ContactCompareDto,
  type ContactCompareFieldDto,
  type ContactDuplicatesDto,
  type DuplicateContactDto,
  type DuplicateGroupDto,
  type DuplicateReason,
  type MergeContactsResultDto,
} from '@btx24/shared';
import { apiGet, apiPost } from '../api.js';
import { openCrm } from '../b24.js';
import { fmtDate, fmtDateTime } from '../format.js';
import { MinimizeButton } from '../Minimize.js';
import { MessengerKindIcon } from '../messengers/MessengerSearchButton.js';
import { Avatar } from '../openlines/Avatar.js';
import { connectorLabel } from '../openlines/format.js';
import { Icon } from '../openlines/icons.js';
import { DashBadge } from '../openlines/RecentCalls.js';
import { BlockLoading } from './BlockLoading.js';

type Filter = 'all' | DuplicateReason;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'phone', label: 'Телефон' },
  { id: 'email', label: 'Почта' },
  { id: 'name', label: 'Имя' },
  { id: 'messenger', label: 'Мессенджер' },
];
/** Сколько групп показываем сразу и сколько добавляет «Показать ещё». */
const PAGE_SIZE = 5;
const REASON_ICON: Record<DuplicateReason, 'phone' | 'mail' | 'person' | 'chat'> = { phone: 'phone', email: 'mail', name: 'person', messenger: 'chat' };

/** «79991234567» → «+7 999 123-45-67»; иначе как есть. */
export function fmtPhone(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length === 11 && d[0] === '7' ? `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}` : v;
}

/** «2 контакта», «5 контактов», «21 контакт». */
export function contactsWord(n: number): string {
  const d = n % 10;
  const h = n % 100;
  const word = d === 1 && h !== 11 ? 'контакт' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'контакта' : 'контактов';
  return `${n} ${word}`;
}

/**
 * Карточка группы: контакты группы, кроме отмеченных «Не объединять» (порядок — как пришёл: старые сначала).
 * `first` — самый ранний (слева, остальные объединятся с ним), `rest` — остальные (справа: один — карточкой,
 * несколько — стопкой, следующий по дате — впереди).
 */
export function splitGroup(contacts: DuplicateContactDto[], excluded: ReadonlySet<number>): { first: DuplicateContactDto | null; rest: DuplicateContactDto[]; included: DuplicateContactDto[] } {
  const included = contacts.filter((c) => !excluded.has(c.id));
  return { first: included[0] ?? null, rest: included.slice(1), included };
}

/** Группа для окна сравнения — только контакты к объединению. */
export function groupForMerge(g: DuplicateGroupDto, excluded: ReadonlySet<number>): DuplicateGroupDto {
  return { ...g, contacts: g.contacts.filter((c) => !excluded.has(c.id)) };
}

/** Почему нельзя объединить выбранное; null — можно. */
export function mergeBlocker(included: number): string | null {
  if (included < 2) return 'Для объединения нужно минимум 2 контакта — снимите отметку «Не объединять»';
  if (included > MERGE_MAX_CONTACTS) return `За раз — не больше ${MERGE_MAX_CONTACTS} контактов: отметьте лишние «Не объединять»`;
  return null;
}

/** Видимые аватарки стопки: до `max` штук; «+N» — сколько не поместилось. */
export function stackView<T>(rest: T[], max = 4): { shown: T[]; more: number } {
  const shown = rest.slice(0, rest.length > max ? max - 1 : max);
  return { shown, more: rest.length - shown.length };
}

/**
 * Убрать объединённые (удалённые в Битрикс24) контакты из загруженного списка: они пропадают из всех
 * групп, группа без пары дублей исчезает целиком, общий счётчик уменьшается на исчезнувшие группы.
 */
export function removeMergedContacts(data: ContactDuplicatesDto, removedIds: number[]): ContactDuplicatesDto {
  const gone = new Set(removedIds);
  const groups = data.groups.map((g) => ({ ...g, contacts: g.contacts.filter((c) => !gone.has(c.id)) })).filter((g) => g.contacts.length >= 2);
  return { ...data, groups, total: Math.max(0, data.total - (data.groups.length - groups.length)) };
}

const CHANNEL_COLORS: Record<string, string> = {
  instagram: '#e94a8d',
  viber: '#8354c9',
  vkgroup: '#1686e9',
  avito: '#00aaff',
  facebook: '#1877f2',
  livechat: '#3269f6',
  imessage: '#34c759',
};

/** Значок канала клиента: WhatsApp/Telegram/MAX — фирменные, остальные — цветная точка с буквой. */
function ChannelIcon({ code }: { code: string }) {
  const label = connectorLabel(code);
  if (code === 'whatsapp' || code === 'telegram' || code === 'max')
    return (
      <span className="dup-ch" title={label}>
        <MessengerKindIcon kind={code} size={16} />
      </span>
    );
  return (
    <span className="dup-ch dup-ch-dot" title={label} style={{ background: CHANNEL_COLORS[code] ?? '#7e95bd' }}>
      {code === 'vkgroup' ? 'vk' : label[0]}
    </span>
  );
}

function Channels({ list }: { list?: string[] }) {
  if (!list?.length) return null;
  return (
    <span className="dup-chs" aria-label={`Мессенджеры: ${list.map(connectorLabel).join(', ')}`}>
      {list.map((m) => (
        <ChannelIcon key={m} code={m} />
      ))}
    </span>
  );
}

const nameOf = (c: DuplicateContactDto) => c.name || `Контакт #${c.id}`;
const subOf = (c: DuplicateContactDto, tz: string) => `#${c.id}${c.createdAt ? ` · с ${fmtDate(c.createdAt, tz)}` : ''}`;

/** Телефоны и почта контакта: показываем до `max` («пилюлями»), остальное — «+N». */
export function contactPills(c: Pick<DuplicateContactDto, 'phones' | 'emails'>, max = 2): { shown: { kind: 'phone' | 'email'; text: string }[]; more: number } {
  const all = [...c.phones.map((p) => ({ kind: 'phone' as const, text: fmtPhone(p) })), ...c.emails.map((e) => ({ kind: 'email' as const, text: e }))];
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}

function Pills({ c, max = 2 }: { c: DuplicateContactDto; max?: number }) {
  const { shown, more } = contactPills(c, max);
  if (!shown.length) return null;
  return (
    <span className="dup-pills">
      {shown.map((p) => (
        <span key={p.kind + p.text} className={`dup-pill ${p.kind}`} title={p.text}>
          <Icon name={p.kind === 'phone' ? 'phone' : 'mail'} size={11} />
          <span>{p.text}</span>
        </span>
      ))}
      {more > 0 && (
        <span className="dup-pill more" title={[...c.phones.map(fmtPhone), ...c.emails].slice(max).join(', ')}>
          +{more}
        </span>
      )}
    </span>
  );
}

/** Контакт карточки: аватарка (под ней мессенджеры), имя, «#id · с даты», телефон/почта; клик — открыть в Битрикс24. */
function ContactSide({ c, tz }: { c: DuplicateContactDto; tz: string }) {
  return (
    <div className="dup-side">
      <div className="dup-ava-col">
        <button type="button" className="dup-ava-btn" title="Открыть контакт в Битрикс24" aria-label={`Открыть контакт ${nameOf(c)}`} onClick={() => openCrm('contact', c.id)}>
          <Avatar src={c.photo} name={nameOf(c)} size={44} />
        </button>
        <Channels list={c.messengers} />
      </div>
      <div className="dup-who">
        <button type="button" className="dup-name" title="Открыть контакт в Битрикс24" onClick={() => openCrm('contact', c.id)}>
          {nameOf(c)}
        </button>
        <span className="dup-meta">{subOf(c, tz)}</span>
        <Pills c={c} />
      </div>
    </div>
  );
}

/** Значок «обмен» (две встречные стрелки). */
function SwapGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" className="dup-swap-glyph">
      <path d="M4 8h15m0 0-4-4m4 4-4 4M20 16H5m0 0 4-4m-4 4 4 4" />
    </svg>
  );
}

/** Большая иконка обмена и «?» — по нажатию список совпадений (что именно совпало). */
function MatchInfo({ reasons }: { reasons: DuplicateGroupDto['reasons'] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const kinds = [...new Set(reasons.map((r) => DUPLICATE_REASON_LABELS[r.kind].toLowerCase()))].join(', ');
  return (
    <div className="dup-link" ref={ref}>
      <span className="dup-swap" title={`Совпадение: ${kinds}`}>
        <SwapGlyph />
      </span>
      <button ref={btn} type="button" className="dup-why" aria-label="Почему это дубли" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        ?
      </button>
      {open && (
        <div id={id} className="dup-pop" role="dialog" aria-label="Совпадения">
          <b>Найдено по совпадению</b>
          <ul>
            {reasons.map((r) => (
              <li key={`${r.kind}:${r.value}`}>
                <span className={`dup-pop-kind ${r.kind}`}>
                  <Icon name={REASON_ICON[r.kind]} size={13} />
                  {DUPLICATE_REASON_LABELS[r.kind]}
                </span>
                <span className="dup-pop-val">{r.kind === 'phone' ? fmtPhone(r.value) : r.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Значение поля по умолчанию при выборе основного: его значение, если заполнено, иначе первое заполненное. */
export function defaultChoice(field: ContactCompareFieldDto, primaryId: number, order: number[]): number {
  const filled = (id: number) => {
    const v = field.values[String(id)];
    return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== '';
  };
  return filled(primaryId) ? primaryId : (order.find(filled) ?? primaryId);
}

/**
 * Блок «Дубли контактов» (только постоянные администраторы приложения): группы контактов одного клиента
 * по телефону, почте и имени из копии CRM, поиск и «Сравнить и объединить».
 */
export function ContactDuplicatesBlock({ tz }: { tz: string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<ContactDuplicatesDto | null>(null);
  const [more, setMore] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [error, setError] = useState('');
  const [merging, setMerging] = useState<DuplicateGroupDto | null>(null);
  // Группа только что объединена: дубли «слетаются» в основной контакт и пропадают (как в Битрикс24).
  const [vanishing, setVanishing] = useState<{ key: string; removed: number[] } | null>(null);
  // «Не объединять» — только в этом блоке (на сервере не сохраняется): ключ группы → ID контактов.
  const [excluded, setExcluded] = useState<Record<string, ReadonlySet<number>>>({});

  // Поиск — с задержкой: печатают телефон или имя целиком.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);
  const params = (cursor?: string) => {
    const p = new URLSearchParams({ by: filter, limit: '20' });
    if (query) p.set('q', query);
    if (cursor) p.set('cursor', cursor);
    return p;
  };
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    setVisible(PAGE_SIZE);
    apiGet<ContactDuplicatesDto>(`/contacts/duplicates?${params()}`).then(
      (d) => active && setData(d),
      (e) => active && setError(e instanceof Error ? e.message : 'Не удалось найти дубли'),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- params собирается из filter/query
  }, [filter, query]);
  const showMore = () => {
    const want = visible + PAGE_SIZE;
    setVisible(want);
    if (data && data.groups.length < want) loadMore();
  };
  const loadMore = () => {
    if (!data?.nextCursor || more) return;
    setMore(true);
    apiGet<ContactDuplicatesDto>(`/contacts/duplicates?${params(data.nextCursor)}`).then(
      (d) => setData((prev) => (prev ? { ...d, groups: [...prev.groups, ...d.groups] } : d)),
      (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить'),
    ).finally(() => setMore(false));
  };

  return (
    <section className="day-panel dash-block dup-block">
      <DashBadge name="people" />
      <p className="dash-attention-title muted">
        Дубли контактов
        {data && <span className="pill">{data.total}</span>}
      </p>
      <div className="dup-toolbar">
        <label className="dup-search">
          <Icon name="search" size={16} />
          <input value={q} placeholder="Телефон, имя или почта" aria-label="Поиск дублей" onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button type="button" aria-label="Очистить поиск" onClick={() => setQ('')}>
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
        <div className="segmented dup-filter" role="radiogroup" aria-label="Совпадение по">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {data && (
        <p className="muted dash-period-note">
          Проверено контактов: {data.scanned.toLocaleString('ru-RU')} · список от {fmtDateTime(data.builtAt, tz)}
        </p>
      )}
      {!data && !error && <BlockLoading rows={3} />}
      {error && <p className="notice error">{error}</p>}
      {data && !data.groups.length && <p className="muted">{query ? 'По запросу дублей не найдено.' : 'Дублей не найдено.'}</p>}
      <ul className="dup-groups">
        {data?.groups.slice(0, visible).map((g) => (
          <GroupCard
            key={g.key}
            group={g}
            tz={tz}
            merging={vanishing?.key === g.key}
            excluded={excluded[g.key] ?? NONE}
            onToggle={(id) =>
              setExcluded((all) => {
                const next = new Set(all[g.key] ?? NONE);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return { ...all, [g.key]: next };
              })
            }
            onMerge={() => setMerging(groupForMerge(g, excluded[g.key] ?? NONE))}
          />
        ))}
      </ul>
      {data && (visible < data.groups.length || data.nextCursor) && (
        <button type="button" className="link dup-more" disabled={more} onClick={showMore}>
          {more ? 'Загрузка…' : `Показать ещё ${Math.min(PAGE_SIZE, Math.max(1, data.total - visible))}`}
        </button>
      )}
      {merging && (
        <MergeDialog
          group={merging}
          tz={tz}
          onClose={() => setMerging(null)}
          onMerged={(removedIds) => {
            // Как в Битрикс24: дубли «слетаются» в основной контакт и пропадают; удалённые убираем
            // из всех групп сразу, не дожидаясь пересборки списка на сервере.
            const key = merging.key;
            setMerging(null);
            setVanishing({ key, removed: removedIds });
            window.setTimeout(() => {
              setVanishing(null);
              setData((d) => (d ? removeMergedContacts(d, removedIds) : d));
            }, 750);
          }}
        />
      )}
    </section>
  );
}

const NONE: ReadonlySet<number> = new Set();

/**
 * Группа дублей: [самый ранний контакт] | [⇄ и «?»] | [второй контакт или стопка с «N контактов»].
 * Больше двух контактов — список раскрывается, у каждого флаг «Не объединять».
 */
function GroupCard({ group: g, tz, merging = false, excluded, onToggle, onMerge }: { group: DuplicateGroupDto; tz: string; merging?: boolean; excluded: ReadonlySet<number>; onToggle: (id: number) => void; onMerge: () => void }) {
  const [open, setOpen] = useState(false);
  const { first, rest, included } = splitGroup(g.contacts, excluded);
  const stack = stackView(rest);
  const blocker = mergeBlocker(included.length);
  const many = g.contacts.length > 2;
  return (
    <li className={`dup-group dup-card${open ? ' open' : ''}${merging ? ' merging' : ''}`}>
      <div className="dup-pair">
        <div className="dup-cell">{first ? <ContactSide c={first} tz={tz} /> : <span className="dup-meta">Все контакты отмечены «Не объединять»</span>}</div>
        <MatchInfo reasons={g.reasons} />
        <div className="dup-cell">
          {rest.length === 1 && !many ? (
            <ContactSide c={rest[0]!} tz={tz} />
          ) : (
            <button type="button" className="dup-stack" aria-expanded={open} title={open ? 'Свернуть список' : 'Показать все контакты группы'} onClick={() => setOpen((v) => !v)}>
              <span className="dup-stack-avas" aria-hidden="true">
                {stack.shown.map((c, i) => (
                  <span key={c.id} className="dup-stack-ava" style={{ zIndex: stack.shown.length - i }}>
                    <Avatar src={c.photo} name={nameOf(c)} size={i === 0 ? 44 : 38} />
                  </span>
                ))}
                {stack.more > 0 && <span className="dup-stack-ava dup-stack-more">+{stack.more}</span>}
              </span>
              <span className="dup-who">
                <span className="dup-name">{rest.length === 1 ? nameOf(rest[0]!) : rest.length ? contactsWord(rest.length) : 'Не с кем объединять'}</span>
                <span className="dup-meta">{rest.length === 1 ? subOf(rest[0]!, tz) : excluded.size ? `не объединять: ${excluded.size}` : 'объединятся с первым'}</span>
                <span className="dup-stack-hint">
                  {open ? 'Свернуть' : 'Все контакты'}
                  <Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
                </span>
              </span>
            </button>
          )}
        </div>
      </div>
      {open && (
        <ul className="dup-rows" aria-label="Контакты группы">
          {g.contacts.map((c) => {
            const off = excluded.has(c.id);
            return (
              <li key={c.id} className={`dup-row${off ? ' off' : ''}${c.id === first?.id ? ' main' : ''}`}>
                <span className="dup-row-who">
                  <button type="button" className="dup-ava-btn" aria-label={`Открыть контакт ${nameOf(c)}`} onClick={() => openCrm('contact', c.id)}>
                    <Avatar src={c.photo} name={nameOf(c)} size={30} />
                  </button>
                  <span className="dup-who">
                    <button type="button" className="dup-name" title="Открыть контакт в Битрикс24" onClick={() => openCrm('contact', c.id)}>
                      {nameOf(c)}
                    </button>
                    <span className="dup-meta">{subOf(c, tz)}</span>
                  </span>
                </span>
                <span className="dup-row-pills">
                  <Pills c={c} max={1} />
                </span>
                <span className="dup-row-chs">
                  <Channels list={c.messengers} />
                </span>
                <label className="dup-skip">
                  <input type="checkbox" checked={off} onChange={() => onToggle(c.id)} />
                  <span>Не объединять</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="dup-card-foot">
        {blocker && <span className="dup-blocker">{blocker}</span>}
        <button type="button" className="dup-merge-btn" disabled={!!blocker} title={blocker ?? `Сравнить и объединить: ${contactsWord(included.length)}`} onClick={onMerge}>
          Сравнить и объединить
        </button>
      </div>
    </li>
  );
}

/** Окно сравнения: столбцы — контакты, строки — поля; где значения разные — выбрать, какое оставить. */
function MergeDialog({ group, tz, onClose, onMerged }: { group: DuplicateGroupDto; tz: string; onClose: () => void; onMerged: (removedIds: number[]) => void }) {
  const [data, setData] = useState<ContactCompareDto | null>(null);
  const [error, setError] = useState('');
  const [primaryId, setPrimaryId] = useState<number | null>(null);
  const [choices, setChoices] = useState<Record<string, number>>({});
  const touched = useRef(new Set<string>());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MergeContactsResultDto | null>(null);
  const key = useRef(crypto.randomUUID());
  const ids = group.contacts.map((c) => c.id);

  useEffect(() => {
    apiGet<ContactCompareDto>(`/contacts/duplicates/compare?ids=${ids.join(',')}`).then(
      (d) => {
        setData(d);
        setPrimaryId(d.suggestedPrimaryId);
      },
      (e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить контакты'),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- группа окна не меняется
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy, onClose]);

  const order = data ? [primaryId!, ...data.contacts.map((c) => c.id).filter((id) => id !== primaryId)] : ids;
  const contacts = data ? order.map((id) => data.contacts.find((c) => c.id === id)!).filter(Boolean) : [];
  const conflicts = data?.fields.filter((f) => f.conflict) ?? [];
  const choiceOf = (f: ContactCompareFieldDto) => (touched.current.has(f.code) ? choices[f.code] : undefined) ?? defaultChoice(f, primaryId ?? ids[0], order);
  const choose = (code: string, id: number) => {
    touched.current.add(code);
    setChoices((c) => ({ ...c, [code]: id }));
    setConfirm(false);
  };
  const removed = order.filter((id) => id !== primaryId);

  const merge = async () => {
    if (!data || primaryId === null || busy) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await apiPost<MergeContactsResultDto>('/contacts/duplicates/merge', {
        idempotencyKey: key.current,
        primaryId,
        ids: order,
        choices: Object.fromEntries(conflicts.map((f) => [f.code, choiceOf(f)])),
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось объединить контакты');
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  const cell = (f: ContactCompareFieldDto, id: number) => {
    const v = f.values[String(id)];
    const empty = v === null || v === undefined || (Array.isArray(v) ? !v.length : !String(v).trim());
    const text = empty ? '—' : Array.isArray(v) ? v.map((x) => (f.code === 'PHONE' ? fmtPhone(x) : x)).join('\n') : String(v);
    const col = id === primaryId ? ' primary-col' : '';
    if (!f.conflict) return <td key={id} className={`${empty ? 'muted' : ''}${col}`}>{text}</td>;
    const picked = choiceOf(f) === id;
    return (
      <td key={id} className={`dup-pick${picked ? ' picked' : ''}${col}`}>
        <label>
          <input type="radio" name={`f-${f.code}`} checked={picked} disabled={busy || !!result} onChange={() => choose(f.code, id)} />
          <span className={empty ? 'muted' : ''}>{text}</span>
        </label>
      </td>
    );
  };

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet bk dup-dialog" role="dialog" aria-modal="true" aria-label="Объединение контактов" onClick={(e) => e.stopPropagation()}>
        <header className="bk-head">
          <div>
            <h3>Объединение контактов</h3>
            <div className="bk-sub">
              {contactsWord(group.contacts.length)} · совпадение: {group.reasons.map((r) => DUPLICATE_REASON_LABELS[r.kind].toLowerCase()).filter((x, i, a) => a.indexOf(x) === i).join(', ')}
            </div>
          </div>
          <div className="pw-head-actions">
            <MinimizeButton label="Объединение" />
            <button type="button" className="bk-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
              ×
            </button>
          </div>
        </header>
        <div className="dup-body">
          {!data && !error && <BlockLoading rows={4} />}
          {error && <p className="notice error">{error}</p>}
          {result && (
            <div className={`notice ${result.status === 'merged' ? 'success' : 'error'}`} role="status">
              {result.status === 'merged' ? (
                <b>
                  Готово: остался контакт #{result.primaryId}, удалены {result.removedIds.map((x) => `#${x}`).join(', ')}.
                </b>
              ) : (
                <>
                  <b>Битрикс24 не смог объединить автоматически.</b> Различаются поля: {result.conflicts.join(', ') || 'неизвестно'} — объедините вручную в Битрикс24.
                </>
              )}
              {result.warnings.map((w) => (
                <span key={w} className="muted">
                  {' '}
                  {w}
                </span>
              ))}
            </div>
          )}
          {data && primaryId !== null && (
            <>
              <p className="muted dup-explain">
                Выберите основной контакт — он останется, остальные удалятся, их сделки, дела и переписка перейдут в основной. Телефоны, почта и мессенджеры объединяются целиком; где значения разные — отметьте, какое оставить.
              </p>
              <div className="dup-table-wrap">
                <table className="dup-table">
                  <thead>
                    <tr>
                      <th scope="col">Поле</th>
                      {contacts.map((c) => (
                        <th key={c.id} scope="col" className={c.id === primaryId ? 'primary-col' : ''}>
                          <label className="dup-primary">
                            <input type="radio" name="primary" checked={c.id === primaryId} disabled={busy || !!result} onChange={() => { setPrimaryId(c.id); setConfirm(false); }} />
                            <span>{c.id === primaryId ? 'Основной' : 'Сделать основным'}</span>
                          </label>
                          <button type="button" className="pw-link dup-col-name" onClick={() => openCrm('contact', c.id)}>
                            {c.name || `Контакт #${c.id}`} <Icon name="external" size={12} />
                          </button>
                          <span className="muted">
                            #{c.id} · сделок: {c.dealsCount}
                            {c.createdAt ? ` · с ${fmtDate(c.createdAt, tz)}` : ''}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.fields.map((f) => (
                      <tr key={f.code} className={f.conflict ? 'conflict' : f.kind === 'multi' ? 'multi' : ''}>
                        <th scope="row">
                          {f.label}
                          {f.conflict && <small className="dup-tag">выбрать</small>}
                          {f.kind === 'multi' && <small className="dup-tag ok">все</small>}
                        </th>
                        {order.map((id) => cell(f, id))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <footer className="pw-footer">
          <span className="muted dup-summary">
            {data && primaryId !== null && !result
              ? `Останется #${primaryId}; удалятся ${removed.map((x) => `#${x}`).join(', ')}${conflicts.length ? ` · различий: ${conflicts.length}` : ''}`
              : ''}
          </span>
          <div className="pw-send-controls">
            <button type="button" disabled={busy} onClick={() => (result?.status === 'merged' ? onMerged(result.removedIds) : onClose())}>
              {result ? 'Закрыть' : 'Отмена'}
            </button>
            {!result && (
              <button type="button" className={`primary${confirm ? ' danger' : ''}`} disabled={!data || busy} onClick={() => void merge()}>
                {busy ? 'Объединяем…' : confirm ? 'Да, объединить — это нельзя отменить' : 'Объединить'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
