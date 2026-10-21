import { describe, expect, it } from 'vitest';
import { nextView, parseView, viewForGroup } from './views.js';

const g = (desktop = '', mobile = '', bookingMode: 'duration' | 'interval' = 'duration') =>
  ({ views: { desktop, mobile }, bookingMode }) as Parameters<typeof viewForGroup>[0];

describe('calendar views', () => {
  it('cycles calendar → list → availability', () => {
    expect([nextView('calendar'), nextView('list'), nextView('availability')]).toEqual([
      'list',
      'availability',
      'calendar',
    ]);
  });
  it('migrates the old saved value', () => {
    expect(parseView('grid')).toBe('calendar');
    expect(parseView('nope')).toBeNull();
  });
  it('applies the group preset for the device even over a user choice', () => {
    expect(viewForGroup(g('list', 'availability'), 'calendar', true, false)).toBe('list');
    expect(viewForGroup(g('list', 'availability'), 'calendar', true, true)).toBe('availability');
  });
  it('without a preset keeps the user choice, otherwise interval groups open availability', () => {
    expect(viewForGroup(g('', '', 'interval'), 'list', true, false)).toBe('list');
    expect(viewForGroup(g('', '', 'interval'), 'list', false, false)).toBe('availability');
    expect(viewForGroup(g(), 'availability', false, true)).toBe('list');
    expect(viewForGroup(g(), 'availability', false, false)).toBe('calendar');
  });
});
