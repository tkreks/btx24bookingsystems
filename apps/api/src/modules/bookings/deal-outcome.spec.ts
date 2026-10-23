import { dealHappened, happened } from './deal-outcome.js';

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

describe('happened — certificate purchase', () => {
  const o = { bookingEnd: 'UF_E', dealType: 'UF_T', paidAmount: 'UF_P', certificateTypeId: '74' };
  const now = Date.parse('2026-10-23T12:00:00Z');
  it('paid and not lost — a successful deal without any booking', () => {
    expect(happened({ STAGE_SEMANTIC_ID: 'P', UF_T: '74', UF_P: '100000|RUB' }, o, now)).toBe(true);
    expect(happened({ STAGE_SEMANTIC_ID: 'S', UF_T: '74', UF_P: '' }, o, now)).toBe(true);
    expect(happened({ STAGE_SEMANTIC_ID: 'P', UF_T: '74', UF_P: '0|RUB' }, o, now)).toBe(false);
    expect(happened({ STAGE_SEMANTIC_ID: 'F', UF_T: '74', UF_P: '100000|RUB' }, o, now)).toBe(false);
  });
  it('other deals — by the booking as before; «booking by certificate» is a booking', () => {
    expect(happened({ STAGE_SEMANTIC_ID: 'P', UF_T: '76', UF_E: '2026-10-22T10:00:00Z' }, o, now)).toBe(true);
    expect(happened({ STAGE_SEMANTIC_ID: 'P', UF_T: '72', UF_P: '5000|RUB' }, o, now)).toBe(false);
    expect(happened({ STAGE_SEMANTIC_ID: 'P', UF_T: '74', UF_P: '100000|RUB' }, { ...o, certificateTypeId: null }, now)).toBe(false);
  });
});
