import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Bitrix24Error } from '../rest/errors.js';

const STATUS: Record<string, number> = {
  READ_ONLY_MODE: HttpStatus.FORBIDDEN,
  ACCESS_DENIED: HttpStatus.FORBIDDEN,
  insufficient_scope: HttpStatus.FORBIDDEN,
  user_access_error: HttpStatus.FORBIDDEN,
  expired_token: HttpStatus.UNAUTHORIZED,
  QUERY_LIMIT_EXCEEDED: HttpStatus.SERVICE_UNAVAILABLE,
  OPERATION_TIME_LIMIT: HttpStatus.SERVICE_UNAVAILABLE,
  PORTAL_INACTIVE: HttpStatus.UNAUTHORIZED,
  REAUTH_REQUIRED: HttpStatus.SERVICE_UNAVAILABLE,
};

const MESSAGE: Record<string, string> = {
  READ_ONLY_MODE: 'Изменения в Битрикс24 сейчас запрещены (режим только чтения)',
  ACCESS_DENIED: 'Недостаточно прав в Битрикс24',
  insufficient_scope: 'У приложения нет нужных прав в Битрикс24',
  expired_token: 'Токен Битрикс24 истёк — обновите авторизацию',
  QUERY_LIMIT_EXCEEDED: 'Битрикс24 ограничил частоту запросов — повторите позже',
};

/** Ошибки Битрикс24 → HTTP-ответ `{ code, message }` (контракт ApiError из @btx24/shared). */
@Catch(Bitrix24Error)
export class Bitrix24ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Bitrix24');

  catch(err: Bitrix24Error, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status = STATUS[err.code] ?? HttpStatus.BAD_GATEWAY;
    if (status >= 500) this.logger.warn(`${err.code}: ${err.message}`);
    const code = err.code === 'expired_token' ? 'TOKEN_EXPIRED' : err.code;
    res.status(status).json({ code, message: MESSAGE[err.code] ?? 'Ошибка обращения к Битрикс24' });
  }
}
