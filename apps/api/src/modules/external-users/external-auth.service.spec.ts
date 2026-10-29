import { ExternalAuthService, MAX_FAILED } from './external-auth.service.js';
import { hashPassword } from './password.js';

async function setup(o: { role?: 'VIEWER' | 'TECHNOLOGIST'; disabled?: boolean; lockedUntil?: Date | null; failed?: number } = {}) {
  const user = { id: 'u1', portalId: 'p1', login: 'viewer', passwordHash: await hashPassword('viewer'), role: o.role ?? 'VIEWER', disabledAt: o.disabled ? new Date() : null, failedLogins: o.failed ?? 0, lockedUntil: o.lockedUntil ?? null };
  const portal = { id: 'p1', domain: 'a.bitrix24.ru', status: 'ACTIVE' };
  const db = {
    portal: { findMany: vi.fn(async () => [portal]) },
    externalUser: {
      findUnique: vi.fn(async ({ where }: { where: { portalId_login: { portalId: string; login: string } } }) => (where.portalId_login.login === 'viewer' && where.portalId_login.portalId === 'p1' ? user : null)),
      update: vi.fn(async () => user),
    },
    externalSession: { create: vi.fn(async () => ({})), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  };
  const log = vi.fn(async () => undefined);
  return { db, log, svc: new ExternalAuthService(db as never, { log } as never) };
}

describe('Вход по логину и паролю', () => {
  it('верный пароль — сессия (в базе только хеш секрета), неудачи сброшены', async () => {
    const t = await setup({ failed: 2 });
    const { secret } = await t.svc.login({ login: ' viewer ', password: 'viewer' }, '1.1.1.1');
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const created = (t.db.externalSession.create.mock.calls[0] as unknown as [{ data: { tokenHash: string } }])[0].data;
    expect(created.tokenHash).not.toBe(secret);
    expect(t.db.externalUser.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failedLogins: 0, lockedUntil: null }) }));
  });
  it('неверный пароль и неизвестный логин — одна и та же ошибка; после 5 неудач — пауза', async () => {
    const t = await setup({ failed: MAX_FAILED - 1 });
    await expect(t.svc.login({ login: 'nobody', password: 'x' }, '1.1.1.2')).rejects.toMatchObject({ response: { code: 'LOGIN_FAILED' } });
    await expect(t.svc.login({ login: 'viewer', password: 'wrong' }, '1.1.1.2')).rejects.toMatchObject({ response: { code: 'LOGIN_FAILED' } });
    expect(t.db.externalUser.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lockedUntil: expect.any(Date) }) }));
    const locked = await setup({ lockedUntil: new Date(Date.now() + 60_000) });
    await expect(locked.svc.login({ login: 'viewer', password: 'viewer' }, '1.1.1.3')).rejects.toMatchObject({ status: 429 });
    expect(locked.db.externalSession.create).not.toHaveBeenCalled();
  });
  it('технолог и отключённый — без сессии', async () => {
    const tech = await setup({ role: 'TECHNOLOGIST' });
    await expect(tech.svc.login({ login: 'viewer', password: 'viewer' }, '1.1.1.4')).rejects.toMatchObject({ status: 403 });
    const off = await setup({ disabled: true });
    await expect(off.svc.login({ login: 'viewer', password: 'viewer' }, '1.1.1.5')).rejects.toMatchObject({ response: { code: 'LOGIN_DISABLED' } });
    expect(tech.db.externalSession.create).not.toHaveBeenCalled();
    expect(off.db.externalSession.create).not.toHaveBeenCalled();
  });
  it('с одного адреса — не больше 20 попыток за 15 минут', async () => {
    const t = await setup();
    for (let i = 0; i < 20; i++) await t.svc.login({ login: 'nobody', password: 'x' }, '9.9.9.9').catch(() => undefined);
    await expect(t.svc.login({ login: 'viewer', password: 'viewer' }, '9.9.9.9')).rejects.toMatchObject({ status: 429 });
  });
});
