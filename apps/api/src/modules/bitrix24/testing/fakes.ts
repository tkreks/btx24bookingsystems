// Тестовые подмены для модуля bitrix24: Prisma в памяти и «портал + сервер авторизации» на fetch.
import type { Portal } from '../../../generated/prisma/client.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { SecretBox } from '../crypto/secret-box.js';
import { OAuthClient } from '../oauth/oauth.client.js';
import { PortalService } from '../portals/portal.service.js';
import { RateLimiter } from '../rest/rate-limiter.js';
import type { Bitrix24Config } from '../bitrix24.tokens.js';

export const KEY = Buffer.alloc(32, 3).toString('base64');
export const MEMBER = 'member-abc';
export const CLIENT_ENDPOINT = 'https://portal.example.ru/rest/';

export function fakePrisma() {
  const portals: Portal[] = [];
  const events: Record<string, unknown>[] = [];
  let seq = 0;
  const prisma = {
    portal: {
      findFirst: async ({ where }: { where: Partial<Portal> }) =>
        portals.find((p) => Object.entries(where).every(([k, v]) => p[k as keyof Portal] === v)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => portals.find((p) => p.id === where.id) ?? null,
      upsert: async ({ where, create, update }: { where: { memberId: string }; create: Partial<Portal>; update: Partial<Portal> }) => {
        const existing = portals.find((p) => p.memberId === where.memberId);
        if (existing) return Object.assign(existing, update, { updatedAt: new Date() });
        const p = { id: `p${++seq}`, timezone: 'Europe/Moscow', createdAt: new Date(), updatedAt: new Date(), ...create } as Portal;
        portals.push(p);
        return p;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Portal> }) => Object.assign(portals.find((p) => p.id === where.id)!, data),
    },
    // Политика записи в режиме «только чтение» спрашивает разрешение «создавать новые»: по умолчанию нет.
    portalSettings: { findUnique: async () => null },
    bitrix24Event: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const e = { id: `e${++seq}`, status: 'PENDING', ...data };
        events.push(e);
        return e;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(events.find((e) => e.id === where.id)!, data),
    },
  };
  return { prisma: prisma as unknown as PrismaService, portals, events };
}

export interface FakeBitrix {
  fetch: typeof fetch;
  oauthCalls: URL[];
  restCalls: { method: string; body: Record<string, unknown> }[];
  /** Ответы REST по имени метода (функция — для динамики). */
  rest: Record<string, unknown | ((body: Record<string, unknown>) => unknown)>;
  /** Ответ сервера авторизации на refresh. */
  oauth: (refreshToken: string) => { status?: number; body: Record<string, unknown> };
}

export function fakeBitrix(): FakeBitrix {
  let n = 0;
  const fb: FakeBitrix = {
    oauthCalls: [],
    restCalls: [],
    rest: { 'user.admin': { result: true }, 'event.bind': { result: true }, scope: { result: ['crm', 'booking', 'placement', 'user'] } },
    oauth: () => {
      n++;
      return {
        body: {
          access_token: `access-${n}`,
          refresh_token: `refresh-${n}`,
          expires_in: 3600,
          member_id: MEMBER,
          client_endpoint: CLIENT_ENDPOINT,
          server_endpoint: 'https://oauth.bitrix.info/rest/',
          scope: 'crm,booking,placement,user',
          user_id: 1,
        },
      };
    },
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth.bitrix.info' && url.pathname === '/oauth/token/') {
        fb.oauthCalls.push(url);
        const r = fb.oauth(url.searchParams.get('refresh_token') ?? '');
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }
      const method = url.pathname.replace(/^\/rest\//, '').replace(/\.json$/, '');
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      fb.restCalls.push({ method, body });
      const reply = fb.rest[method];
      const value = typeof reply === 'function' ? reply(body) : (reply ?? { error: 'ERROR_METHOD_NOT_FOUND' });
      return new Response(JSON.stringify(value), { status: (value as { error?: string }).error ? 400 : 200 });
    }) as typeof fetch,
  };
  return fb;
}

export function makePortalService(opts: { config?: Partial<Bitrix24Config>; clientId?: string } = {}) {
  const db = fakePrisma();
  const b24 = fakeBitrix();
  const config: Bitrix24Config = { appBaseUrl: 'https://app.example.ru', trustedOAuthHosts: ['oauth.bitrix.info'], readOnly: false, sandbox: null, ...opts.config };
  const oauth = new OAuthClient(opts.clientId ?? 'app.client', 'secret', b24.fetch);
  const box = new SecretBox(KEY);
  const service = new PortalService(db.prisma, box, oauth, new RateLimiter(1000, 1000), config, b24.fetch);
  return { ...db, b24, config, oauth, box, service };
}
