import { RateLimiter } from './rate-limiter.js';

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('RateLimiter', () => {
  it('lets a burst through, then paces at the steady rate', async () => {
    const c = fakeClock();
    const limiter = new RateLimiter(2, 3, c.now, c.sleep);
    for (let i = 0; i < 5; i++) await limiter.acquire('portal-a');
    expect(c.sleeps).toEqual([500, 500]);
  });

  it('keeps separate budgets per portal', async () => {
    const c = fakeClock();
    const limiter = new RateLimiter(2, 1, c.now, c.sleep);
    await limiter.acquire('a');
    await limiter.acquire('b');
    expect(c.sleeps).toEqual([]);
  });
});
