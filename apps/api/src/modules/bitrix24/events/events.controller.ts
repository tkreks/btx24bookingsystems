import { Body, Controller, HttpCode, HttpException, Post } from '@nestjs/common';
import { EventsService, type IncomingEvent } from './events.service.js';

/** Обработчик событий, привязываемый через event.bind: `<APP_BASE_URL>/api/b24/events`. */
@Controller('b24/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Post()
  @HttpCode(200)
  async handle(@Body() body: IncomingEvent) {
    const outcome = await this.events.receive(body ?? {});
    if (outcome === 'rejected') throw new HttpException({ ok: false }, 401);
    return { ok: true };
  }
}
