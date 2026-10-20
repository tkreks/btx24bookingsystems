import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { SecretBox } from './crypto/secret-box.js';
import { EventsController } from './events/events.controller.js';
import { EventsService } from './events/events.service.js';
import { InstallController } from './install/install.controller.js';
import { InstallService } from './install/install.service.js';
import { OAuthClient } from './oauth/oauth.client.js';
import { PortalService } from './portals/portal.service.js';
import { RateLimiter } from './rest/rate-limiter.js';
import { B24_CONFIG, B24_FETCH, type Bitrix24Config } from './bitrix24.tokens.js';

/**
 * Единственная точка обращения к Битрикс24: установка, токены порталов, события, REST-клиент.
 * Доменные модули получают клиент через PortalService.clientFor(portal), а не ходят в портал сами.
 */
@Module({
  controllers: [InstallController, EventsController],
  providers: [
    { provide: B24_FETCH, useValue: globalThis.fetch.bind(globalThis) },
    {
      provide: B24_CONFIG,
      inject: [ConfigService],
      useFactory: (c: ConfigService<Env, true>): Bitrix24Config => ({
        appBaseUrl: c.get('APP_BASE_URL', { infer: true }),
        trustedOAuthHosts: c.get('B24_TRUSTED_OAUTH_HOSTS', { infer: true }),
      }),
    },
    { provide: SecretBox, inject: [ConfigService], useFactory: (c: ConfigService<Env, true>) => new SecretBox(c.get('ENCRYPTION_KEY', { infer: true })) },
    {
      provide: OAuthClient,
      inject: [ConfigService, B24_FETCH],
      useFactory: (c: ConfigService<Env, true>, f: typeof fetch) => new OAuthClient(c.get('B24_CLIENT_ID', { infer: true }), c.get('B24_CLIENT_SECRET', { infer: true }), f),
    },
    {
      provide: RateLimiter,
      inject: [ConfigService],
      useFactory: (c: ConfigService<Env, true>) => new RateLimiter(c.get('B24_RATE_PER_SEC', { infer: true }), c.get('B24_RATE_BURST', { infer: true })),
    },
    PortalService,
    InstallService,
    EventsService,
  ],
  exports: [PortalService],
})
export class Bitrix24Module {}
