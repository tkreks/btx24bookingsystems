import { describe, expect, it } from 'vitest';
import { effectivePermissions, higherRole } from './access.js';

describe('access', () => {
  it('intersects role permissions with group features', () => {
    expect(effectivePermissions('MANAGER', ['booking.details', 'booking.create'])).toEqual(['calendar.view', 'booking.details', 'booking.create']);
    expect(effectivePermissions('TECHNOLOGIST', ['booking.details'])).toEqual(['calendar.view']);
  });

  it('keeps calendar.view and group.manage regardless of features', () => {
    expect(effectivePermissions('GROUP_ADMIN', [])).toEqual(['calendar.view', 'group.manage']);
  });

  it('picks the higher role', () => {
    expect(higherRole(null, 'VIEWER')).toBe('VIEWER');
    expect(higherRole('MANAGER', 'VIEWER')).toBe('MANAGER');
    expect(higherRole('TECHNOLOGIST', 'VIEWER')).toBe('VIEWER');
  });
});
