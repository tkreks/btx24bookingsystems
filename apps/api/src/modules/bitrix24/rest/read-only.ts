/**
 * Режим «только чтение» (B24_READ_ONLY, по умолчанию включён): пока владелец не разрешил изменения
 * на боевом портале, клиент отклоняет любые изменяющие методы ещё до запроса.
 */

/** Последний сегмент имени метода, означающий чтение: crm.deal.list, booking.v1.booking.get, … */
const READ_VERBS = new Set(['list', 'get', 'fields', 'current', 'admin', 'info']);

/**
 * Служебные методы регистрации самого приложения (не данные портала): без них не работают
 * обработка удаления приложения и встройки. Разрешены и в режиме чтения.
 */
const APP_SYSTEM_METHODS = new Set(['event.bind', 'event.unbind', 'event.get', 'placement.bind', 'placement.unbind', 'placement.get', 'app.info', 'scope', 'methods', 'profile']);

/** Чтения с нестандартным именем: ищут, ничего не меняя. Добавлять поимённо, не по глаголу. */
const READ_METHODS = new Set([
  'user.search',
  // поиск клиента по номеру телефона (чаты по телефону)
  'crm.duplicate.findbycomm',
  // обзор Диска — выбор файлов для сообщений клиенту
  'disk.storage.getlist',
  'disk.storage.getchildren',
  'disk.folder.getchildren',
  // статус своего рабочего дня
  'timeman.status',
  // одноразовая ссылка на файл чата (картинки и видео в чате приложения)
  'im.v2.file.download',
]);

export function isReadMethod(method: string): boolean {
  const m = method.toLowerCase();
  if (APP_SYSTEM_METHODS.has(m) || READ_METHODS.has(m)) return true;
  const verb = m.slice(m.lastIndexOf('.') + 1);
  return READ_VERBS.has(verb);
}
