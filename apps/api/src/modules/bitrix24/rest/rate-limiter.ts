/**
 * «Ведро токенов» на каждый портал: Битрикс24 ограничивает частоту REST-запросов приложения
 * (порядка 2 запросов в секунду с допустимым всплеском). Действует в пределах процесса —
 * api и worker ограничиваются независимо, поэтому лимиты по умолчанию консервативные.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number; queue: Promise<void> }>();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Ждёт, пока для ключа (member_id) можно отправить ещё один запрос. Порядок вызовов сохраняется. */
  acquire(key: string): Promise<void> {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, updatedAt: this.now(), queue: Promise.resolve() };
      this.buckets.set(key, bucket);
    }
    const b = bucket;
    const turn = b.queue.then(async () => {
      for (;;) {
        const t = this.now();
        b.tokens = Math.min(this.burst, b.tokens + ((t - b.updatedAt) / 1000) * this.ratePerSec);
        b.updatedAt = t;
        if (b.tokens >= 1) {
          b.tokens -= 1;
          return;
        }
        await this.sleep(Math.ceil(((1 - b.tokens) / this.ratePerSec) * 1000));
      }
    });
    b.queue = turn.catch(() => undefined);
    return turn;
  }
}
