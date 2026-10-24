import { expect, it } from 'vitest';
import { callTone, callTypeLabel, callTypeIcon, callDurationText, callTimeText } from './RecentCalls.js';
import type { CallLogRowDto } from '@btx24/shared';
it.each([
  ['incoming', 'success', false, 'Входящий', 'in', 'arrowDown'],
  ['incoming', 'missed', false, 'Пропущенный', 'missed', 'close'],
  ['incoming', 'missed', true, 'Упущенный', 'lost', 'callLost'],
  ['outgoing', 'success', false, 'Исходящий', 'out', 'arrowUp'],
  ['outgoing', 'no_answer', false, 'Исходящий', 'noanswer', 'arrowUp'],
] as const)('тип и оформление %s %s %s', (direction, status, lost, label, tone, icon) => {
  const c: Pick<CallLogRowDto, 'direction' | 'status' | 'lost'> = { direction, status, lost };
  expect(callTypeLabel(c)).toBe(label); expect(callTone(c)).toBe(tone); expect(callTypeIcon(c)).toBe(icon);
});

it.each([
  [232, '3 мин 52 с'], [8, '8 с'], [53, '53 с'], [173, '2 мин 53 с'],
  [0, '0 с'], [60, '1 мин'], [3600, '1 ч'], [3661, '1 ч 1 мин 1 с'],
])('длительность %s явно отличается от времени начала: %s', (seconds, label) => {
  expect(callDurationText(seconds)).toBe(label);
});

it.each([
  ['2026-10-24T01:02:00+03:00', '2026-10-24', '2026-10-24', '01:02'],
  ['2026-10-23T23:53:00+03:00', '2026-10-23', '2026-10-23', 'вчера 23:53'],
  ['2026-10-22T01:02:00+03:00', '2026-10-22', '2026-10-22', '22.10.2026 01:02'],
  ['2026-10-24T01:02:00+03:00', '2026-10-20', '2026-10-24', '24.10.2026 01:02'],
] as const)('время %s для периода %s–%s: %s', (at, from, to, expected) => {
  expect(callTimeText(at, 'Europe/Moscow', from, to, new Date('2026-10-24T12:00:00Z'))).toBe(expected);
});
it('сегодня и дата звонка определяются по зоне портала у полуночи', () => {
  expect(callTimeText('2026-10-24T22:02:00Z', 'Europe/Moscow', '2026-10-25', '2026-10-25', new Date('2026-10-24T23:00:00Z'))).toBe('01:02');
});
