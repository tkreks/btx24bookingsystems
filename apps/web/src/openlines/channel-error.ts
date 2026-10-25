/** Уведомление провайдера в тексте — признак ошибки отправки, не проверка состояния канала. */
export function hasDisabledWazzupChannel(connector: string, text: string | null | undefined): boolean {
  if (!connector.startsWith('wz_') || !text) return false;
  const plain = text.replace(/\[br\s*\/?\]|<br\s*\/?>/gi, ' ');
  return /===\s*SYSTEM\s+WZ\s*===[\s:]*Ошибка\s+отправки\s+сообщения\s*:\s*канал\s+выключен/iu.test(plain);
}

export function channelProvider(connector: string): string | null {
  return connector.startsWith('btx24_') ? 'Приложение' : connector.startsWith('wz_') ? 'Wazzup' : null;
}
