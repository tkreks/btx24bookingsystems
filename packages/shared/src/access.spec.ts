import { describe, expect, it } from 'vitest';
import { effectivePermissions, higherRole } from './access.js';
import { canUsePaymentMode } from './bookings.js';

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

  it('allows free and postpay only with booking.create and deal.create', () => {
    expect(canUsePaymentMode(['booking.create'], 'prepayment')).toBe(true);
    expect(canUsePaymentMode(['booking.create'], 'cash_on_site')).toBe(true);
    expect(canUsePaymentMode(['booking.create'], 'free')).toBe(false);
    expect(canUsePaymentMode(['deal.create'], 'postpay')).toBe(false);
    expect(canUsePaymentMode(['booking.create', 'deal.create'], 'free')).toBe(true);
  });
});
