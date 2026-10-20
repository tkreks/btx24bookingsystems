const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Страница в iframe установки: при успехе вызывает BX24.installFinish(). */
export function installPage(ok: boolean, message: string): string {
  const finish = ok ? '<script>BX24.init(function(){BX24.installFinish();});</script>' : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Установка приложения</title><script src="//api.bitrix24.com/api/v1/"></script>
<style>body{font-family:system-ui,-apple-system,sans-serif;margin:32px;color:#111827}.err{color:#b91c1c}</style></head>
<body><h1>Система бронирования</h1><p class="${ok ? '' : 'err'}">${esc(message)}</p>${finish}</body></html>`;
}
