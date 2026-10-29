import { randomBytes } from 'node:crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Portal } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { sha256Hex } from '../bitrix24/crypto/secret-box.js';
import { AuthError } from '../bitrix24/auth/user-token.verifier.js';
import { ActionLogService } from '../audit/action-log.service.js';
import { hashPassword, verifyPassword } from './password.js';

/** Cookie сессии внешнего пользователя (отдельно от входа сотрудников через Битрикс24). */
export const EXTERNAL_COOKIE = 'btx24_ext';
export const EXTERNAL_TTL_MS = 30 * 24 * 3600_000;
/** Неудачных входов подряд до паузы и длина паузы. */
export const MAX_FAILED = 5;
export const LOCK_MS = 15 * 60_000;
/** С одного адреса — не больше попыток за окно (подбор по многим логинам). */
const IP_LIMIT = 20;
const IP_WINDOW_MS = 15 * 60_000;
const WRONG = 'Неверный логин или пароль';

export interface ExternalUserContext {
  portal: Portal;
  user: { id: string; login: string; role: 'VIEWER' | 'TECHNOLOGIST'; allGroups: boolean; visibleFields: string[] | null; groupIds: string[] };
}

/**
 * Вход внешних пользователей по логину и паролю (роль `viewer`; технолог — позже, TECH_DEBT).
 * Пароль — только хеш (scrypt); неизвестный логин проверяется так же долго, как известный. После
 * 5 неудач подряд — пауза 15 минут, с одного адреса — не больше 20 попыток за 15 минут.
 */
@Injectable()
export class ExternalAuthService {
  private readonly byIp = new Map<string, { count: number; resetAt: number }>();
  private dummy: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: ActionLogService,
  ) {}

  async login(input: { login: string; password: string; domain?: string }, ip: string): Promise<{ secret: string; portal: Portal }> {
    this.countIp(ip);
    const portal = await this.portal(input.domain);
    const login = input.login.trim();
    const user = await this.prisma.externalUser.findUnique({ where: { portalId_login: { portalId: portal.id, login } } });
    if (!user) {
      await verifyPassword(input.password, await (this.dummy ??= hashPassword(randomBytes(16).toString('hex'))));
      throw new AuthError('LOGIN_FAILED', WRONG);
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now())
      throw new HttpException({ code: 'LOGIN_LOCKED', message: `Слишком много неудачных попыток. Повторите через ${Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000)} мин.` }, HttpStatus.TOO_MANY_REQUESTS);
    const ok = await verifyPassword(input.password, user.passwordHash);
    if (!ok) {
      const failed = user.failedLogins + 1;
      const locked = failed >= MAX_FAILED;
      await this.prisma.externalUser.update({ where: { id: user.id }, data: { failedLogins: locked ? 0 : failed, ...(locked ? { lockedUntil: new Date(Date.now() + LOCK_MS) } : {}) } });
      await this.actions.log(portal.id, actor(login), { action: 'external.login_failed', summary: locked ? `Вход по паролю: «${login}» — пауза после ${MAX_FAILED} неудач` : `Вход по паролю: неверный пароль «${login}»`, entityType: 'external_user', entityId: user.id, via: 'web' });
      throw new AuthError('LOGIN_FAILED', WRONG);
    }
    if (user.disabledAt) throw new AuthError('LOGIN_DISABLED', 'Вход для этого пользователя отключён');
    if (user.role !== 'VIEWER') throw new HttpException({ code: 'ROLE_NOT_READY', message: 'Вход для роли «технолог» пока не готов' }, HttpStatus.FORBIDDEN);
    const secret = randomBytes(32).toString('hex');
    await this.prisma.$transaction([
      this.prisma.externalUser.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } }),
      this.prisma.externalSession.create({ data: { portalId: portal.id, externalUserId: user.id, tokenHash: sha256Hex(secret), expiresAt: new Date(Date.now() + EXTERNAL_TTL_MS) } }),
    ]);
    await this.actions.log(portal.id, actor(login), { action: 'external.login', summary: `Вход по паролю: «${login}»`, entityType: 'external_user', entityId: user.id, via: 'web' });
    return { secret, portal };
  }

  /** Сессия по cookie → портал и права; нет, истекла, пользователь отключён — ошибка входа. */
  async resolve(secret: string): Promise<ExternalUserContext> {
    const s = await this.prisma.externalSession.findUnique({
      where: { tokenHash: sha256Hex(secret) },
      include: { portal: true, externalUser: { include: { groups: { select: { groupId: true } } } } },
    });
    const u = s?.externalUser;
    if (!s || !u || s.expiresAt.getTime() < Date.now() || s.portal.status !== 'ACTIVE' || u.disabledAt || u.role !== 'VIEWER')
      throw new AuthError('SESSION_EXPIRED', 'Сессия входа истекла — войдите снова');
    // Скользящий срок, запись не чаще раза в час.
    if (Date.now() - s.lastSeenAt.getTime() > 3600_000)
      await this.prisma.externalSession.updateMany({ where: { id: s.id, lastSeenAt: s.lastSeenAt }, data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + EXTERNAL_TTL_MS) } });
    const fields = Array.isArray(u.visibleFields) ? u.visibleFields.filter((f): f is string => typeof f === 'string') : null;
    return { portal: s.portal, user: { id: u.id, login: u.login, role: u.role, allGroups: u.allGroups, visibleFields: fields, groupIds: u.groups.map((g) => g.groupId) } };
  }

  async logout(secret: string): Promise<void> {
    await this.prisma.externalSession.deleteMany({ where: { tokenHash: sha256Hex(secret) } });
  }

  private async portal(domain: string | undefined): Promise<Portal> {
    const portals = await this.prisma.portal.findMany({ where: { status: 'ACTIVE' } });
    const want = (domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const portal = want ? portals.find((p) => p.domain.toLowerCase() === want) : portals.length === 1 ? portals[0] : undefined;
    if (!portal) throw new AuthError('PORTAL_NOT_INSTALLED', want ? `Приложение не установлено на портале ${want}` : 'Укажите адрес портала');
    return portal;
  }

  private countIp(ip: string): void {
    const now = Date.now();
    if (this.byIp.size > 10_000) for (const [k, v] of this.byIp) if (v.resetAt < now) this.byIp.delete(k);
    const hit = this.byIp.get(ip);
    if (!hit || hit.resetAt < now) return void this.byIp.set(ip, { count: 1, resetAt: now + IP_WINDOW_MS });
    if (++hit.count > IP_LIMIT) throw new HttpException({ code: 'LOGIN_RATE_LIMIT', message: 'Слишком много попыток входа. Повторите позже.' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

const actor = (login: string) => ({ kind: 'system' as const, name: `Внешний пользователь «${login.slice(0, 100)}»` });
