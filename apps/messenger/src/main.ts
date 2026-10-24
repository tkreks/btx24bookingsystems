import { Manager, setEventSink } from './manager.js';
import { Outbox } from './messages.js';
import { ScreenFiles } from './screen-files.js';
import { createMessengerServer } from './server.js';

// Точка входа контейнера messenger (ADR 0014): браузеры мессенджеров и их экраны.
const dataDir = process.env.MESSENGER_DATA_DIR ?? '/data';
const manager = new Manager({
  dataDir,
  chromium: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  display: process.env.MESSENGER_DISPLAY !== '0',
  proxy: process.env.MESSENGER_PROXY?.trim() || undefined,
});
// Переписка → api: входящие, отправленные, правки, удаления, статусы.
const outbox = new Outbox(process.env.MESSENGER_API_HOOK ?? 'http://api:3000/api/messengers/hook', process.env.MESSENGER_TOKEN ?? '');
setEventSink((e) => outbox.push(e));
// Файлы для экрана мессенджера — час, потом удаляются.
const screenFiles = new ScreenFiles(dataDir);
setInterval(() => void screenFiles.sweep().catch(() => undefined), 5 * 60_000).unref();
const server = createMessengerServer(manager, process.env.MESSENGER_TOKEN ?? '', screenFiles);
await manager.boot();
server.listen(Number(process.env.PORT ?? 3090), '0.0.0.0', () => console.log(`messenger listening on ${process.env.PORT ?? 3090}`));

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    server.close();
    void manager.shutdown().finally(() => process.exit(0));
  });
