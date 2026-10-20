import { Inject, Injectable } from '@nestjs/common';
import { Bitrix24Error } from '../rest/errors.js';
import type { Bitrix24RestClient } from '../rest/rest-client.js';
import { B24_CONFIG, type Bitrix24Config } from '../bitrix24.tokens.js';
import { APP_PLACEMENTS, type PlacementStatus } from './placements.js';

/**
 * Регистрация встроек. НЕ выполняется автоматически при установке: на боевом портале вкладка
 * в сделке появится у всех менеджеров — включается явным действием администратора.
 */
@Injectable()
export class PlacementsService {
  constructor(@Inject(B24_CONFIG) private readonly config: Bitrix24Config) {}

  handler(): string {
    if (!this.config.appBaseUrl) throw new Bitrix24Error('APP_BASE_URL_MISSING', 'APP_BASE_URL is not set');
    return `${this.config.appBaseUrl.replace(/\/$/, '')}/`;
  }

  async status(client: Bitrix24RestClient): Promise<PlacementStatus[]> {
    const handler = this.handler();
    const res = await client.call<{ placement?: string; PLACEMENT?: string; handler?: string; HANDLER?: string }[]>('placement.get');
    const bound = new Set(
      (Array.isArray(res.result) ? res.result : [])
        .filter((p) => (p.handler ?? p.HANDLER) === handler)
        .map((p) => p.placement ?? p.PLACEMENT),
    );
    return APP_PLACEMENTS.map((p) => ({ ...p, bound: bound.has(p.placement) }));
  }

  /** Привязывает недостающие встройки; повторный вызов ничего не дублирует. */
  async sync(client: Bitrix24RestClient): Promise<PlacementStatus[]> {
    const handler = this.handler();
    for (const p of await this.status(client)) {
      if (p.bound) continue;
      await client.call('placement.bind', { PLACEMENT: p.placement, HANDLER: handler, TITLE: p.title, LANG_ALL: { ru: { TITLE: p.title } } });
    }
    return this.status(client);
  }
}
