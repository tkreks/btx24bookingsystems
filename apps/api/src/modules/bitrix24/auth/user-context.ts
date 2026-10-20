import type { Portal } from '../../../generated/prisma/client.js';
import type { Bitrix24RestClient } from '../rest/rest-client.js';

/** Кто делает запрос: портал + пользователь Битрикс24 + клиент REST с его токеном (его права). */
export interface B24UserContext {
  portal: Portal;
  userId: number;
  userName: string;
  isAdmin: boolean;
  /** Прямые отделы сотрудника (UF_DEPARTMENT из user.current). */
  departmentIds: number[];
  /** REST-клиент на токене пользователя — видит только то, что видит он сам. */
  client: Bitrix24RestClient;
}

/** Заголовки, которые интерфейс передаёт с каждым запросом (значения — из BX24.getAuth()). */
export const AUTH_HEADER = 'authorization';
export const MEMBER_HEADER = 'x-b24-member-id';
