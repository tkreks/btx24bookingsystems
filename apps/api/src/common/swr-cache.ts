/**
 * Кэш ответов «stale-while-revalidate» для блоков дашборда (ADR 0012): свежий ответ отдаётся сразу,
 * устаревший — тоже сразу, но одновременно пересчитывается в фоне; совсем старый — ждём пересчёт.
 * Ключ собирает вызывающий: портал, сотрудник, его права и параметры запроса — чужой ответ не
 * достаётся. Ответ помечен разделами данных (`CacheTag`) и порталом: изменение сбрасывает только
 * свои разделы своего портала (`invalidate`), остальные ответы остаются пригодными.
 */
export interface SwrOptions {
  /** Столько ответ отдаётся без пересчёта. */
  freshMs: number;
  /** До стольких — отдаётся сразу, а пересчёт идёт в фоне. */
  staleMs: number;
}

/** Разделы данных: что именно изменилось. `access` — права и настройки (затрагивает всё). */
export const CACHE_TAGS = ['bookings', 'deals', 'calls', 'chats', 'activity', 'access'] as const;
export type CacheTag = (typeof CACHE_TAGS)[number];

/** Как был получен ответ: `fresh`/`stale` — из кэша (свежий / устаревший, пересчёт в фоне), `miss` — посчитан сейчас. */
export interface SwrMeta {
  state: 'fresh' | 'stale' | 'miss';
  /** Возраст данных на момент ответа, мс. */
  ageMs: number;
  /** Идёт пересчёт в фоне — скоро будет свежий ответ. */
  refreshing: boolean;
}

/** Поколения разделов: `portal|tag` и `*|tag` (все порталы) — растут при изменении. */
const generations = new Map<string, number>();
const gen = (key: string) => generations.get(key) ?? 0;

/** Сбросить разделы портала (`scope` — member_id; null — всех порталов). `'all'` — все разделы. */
export function invalidate(scope: string | null, tags: readonly CacheTag[] | 'all'): void {
  for (const tag of tags === 'all' ? CACHE_TAGS : tags) {
    const key = `${scope ?? '*'}|${tag}`;
    generations.set(key, gen(key) + 1);
  }
}

/** Отпечаток поколений разделов ответа: совпал — ни один его раздел не менялся. */
function stampOf(scope: string, tags: readonly CacheTag[]): string {
  return [...new Set<CacheTag>([...tags, 'access'])].map((t) => `${gen(`${scope}|${t}`)}.${gen(`*|${t}`)}`).join(',');
}

type Entry<T> = { at: number; stamp: string; value: T | null; flight: Promise<T> | null };

export class SwrCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly max = 1000,
    private readonly now = () => Date.now(),
  ) {}

  async get(
    key: string,
    compute: () => Promise<T>,
    opts: SwrOptions & { scope: string; tags: readonly CacheTag[] },
  ): Promise<{ value: T; meta: SwrMeta }> {
    const now = this.now();
    const stamp = stampOf(opts.scope, opts.tags);
    const e = this.entries.get(key);
    const usable = e && e.value !== null && e.stamp === stamp;
    if (usable && now - e.at < opts.freshMs) return { value: e.value as T, meta: { state: 'fresh', ageMs: now - e.at, refreshing: !!e.flight } };
    if (usable && now - e.at < opts.staleMs) {
      // Ошибка фонового пересчёта не мешает: остаётся прежний ответ, следующий запрос попробует снова.
      if (!e.flight) this.run(key, e, compute, opts).catch(() => undefined);
      return { value: e.value as T, meta: { state: 'stale', ageMs: now - e.at, refreshing: true } };
    }
    const flight = e?.flight && e.stamp === stamp ? e.flight : this.run(key, e && e.stamp === stamp ? e : undefined, compute, opts);
    return { value: await flight, meta: { state: 'miss', ageMs: 0, refreshing: false } };
  }

  private run(key: string, prev: Entry<T> | undefined, compute: () => Promise<T>, opts: { scope: string; tags: readonly CacheTag[] }): Promise<T> {
    const stamp = stampOf(opts.scope, opts.tags);
    const entry: Entry<T> = prev ?? { at: 0, stamp, value: null, flight: null };
    const flight = compute().then((value) => {
      // Пока считали, раздел изменился — ответ отдаём, но не запоминаем.
      if (stampOf(opts.scope, opts.tags) === stamp) Object.assign(entry, { at: this.now(), stamp, value });
      return value;
    });
    entry.flight = flight;
    void flight.then(
      () => (entry.flight = null),
      () => (entry.flight = null),
    );
    if (!prev) {
      if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value as string);
      this.entries.set(key, entry);
    }
    return flight;
  }
}
