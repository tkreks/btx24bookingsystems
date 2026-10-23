import { Inject, Injectable } from '@nestjs/common';
import { Bitrix24Error } from '../rest/errors.js';
import type { Bitrix24RestClient } from '../rest/rest-client.js';
import { B24_CONFIG, type Bitrix24Config } from '../bitrix24.tokens.js';
import { OPTIONAL_EVENTS } from '../install/install.service.js';
import { APP_PLACEMENTS, type PlacementsStateDto } from './placements.js';

/**
 * Регистрация встроек и подписок на события звонков. НЕ выполняется автоматически при установке: на
 * боевом портале вкладка в сделке появится у всех менеджеров — включается явным действием администратора.
 */
@Injectable()
export class PlacementsService {
  constructor(@Inject(B24_CONFIG) private readonly config: Bitrix24Config) {}

  handler(): string {
    if (!this.config.appBaseUrl) throw new Bitrix24Error('APP_BASE_URL_MISSING', 'APP_BASE_URL is not set');
    return `${this.config.appBaseUrl.replace(/\/$/, '')}/`;
  }

  private eventHandler(): string {
    return `${this.handler()}api/b24/events`;
  }

  async status(client: Bitrix24RestClient): Promise<PlacementsStateDto> {
    const handler = this.handler();
    const [placements, events] = await Promise.all([
      client.call<{ placement?: string; PLACEMENT?: string; handler?: string; HANDLER?: string }[]>('placement.get'),
      client.call<{ event?: string; handler?: string }[]>('event.get').catch(() => ({ result: [] })),
    ]);
    const bound = new Set(
      (Array.isArray(placements.result) ? placements.result : [])
        .filter((p) => (p.handler ?? p.HANDLER) === handler)
        .map((p) => p.placement ?? p.PLACEMENT),
    );
    const boundEvents = new Set(
      (Array.isArray(events.result) ? events.result : []).filter((e) => e.handler === this.eventHandler()).map((e) => String(e.event).toUpperCase()),
    );
    return {
      placements: APP_PLACEMENTS.map((p) => ({ ...p, bound: bound.has(p.placement) })),
      events: OPTIONAL_EVENTS.map((event) => ({ event, bound: boundEvents.has(event) })),
    };
  }

  /** Привязывает недостающие встройки и события звонков; повторный вызов ничего не дублирует. */
  async sync(client: Bitrix24RestClient): Promise<PlacementsStateDto> {
    const handler = this.handler();
    const state = await this.status(client);
    for (const p of state.placements) {
      if (p.bound) continue;
      await client.call('placement.bind', { PLACEMENT: p.placement, HANDLER: handler, TITLE: p.title, LANG_ALL: { ru: { TITLE: p.title } } });
    }
    for (const e of state.events) if (!e.bound) await client.call('event.bind', { event: e.event, handler: this.eventHandler() });
    return this.status(client);
  }

  /**
   * «Перевстроить»: снять встройки и подписки приложения и поставить заново (портал запомнил старые
   * названия, обработчик или права). Снятие отсутствующего — не ошибка.
   */
  async rebind(client: Bitrix24RestClient): Promise<PlacementsStateDto> {
    const handler = this.handler();
    for (const p of APP_PLACEMENTS) await client.call('placement.unbind', { PLACEMENT: p.placement, HANDLER: handler }).catch(() => undefined);
    for (const event of OPTIONAL_EVENTS) await client.call('event.unbind', { event, handler: this.eventHandler() }).catch(() => undefined);
    return this.sync(client);
  }
}
