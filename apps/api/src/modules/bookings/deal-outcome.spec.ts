import { dealHappened } from './deal-outcome.js';

const now = Date.parse('2026-10-21T10:00:00Z');
describe('dealHappened', () => {
  it('past booking in an intermediate stage counts; lost never; future booking not yet', () => {
    expect(dealHappened({ STAGE_SEMANTIC_ID: 'P' }, '2026-10-01T12:00:00+03:00', now)).toBe(true);
    expect(dealHappened({ STAGE_SEMANTIC_ID: 'F' }, '2026-10-01T12:00:00+03:00', now)).toBe(false);
    expect(dealHappened({ STAGE_SEMANTIC_ID: 'S' }, '2026-10-25T12:00:00+03:00', now)).toBe(false);
  });
  it('without a booking date — only won deals closed before the moment', () => {
    expect(dealHappened({ STAGE_SEMANTIC_ID: 'S', CLOSEDATE: '2026-09-01T00:00:00+03:00' }, null, now)).toBe(true);
    expect(dealHappened({ STAGE_SEMANTIC_ID: 'S', CLOSEDATE: '2026-11-01T00:00:00+03:00' }, null, now)).toBe(false);
    expect(dealHappened({ STAGE_SEMANTIC_ID: 'P' }, null, now)).toBe(false);
  });
});
