import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { vncPort } from './instance.js';
import type { Manager } from './manager.js';
import { FileOffers, type ScreenFiles } from './screen-files.js';
import { ID_RE, isKind, normalizePhone } from './spec.js';

const TOKEN_HEADER = 'x-messenger-token';

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Внутренний HTTP сервиса (только сеть стенда, наружу не публикуется; с `MESSENGER_TOKEN` — ещё и по
 * токену). Вызывает только api: права администратора, портал и журнал — там.
 *
 * GET /instances · PUT /instances/:id {kind, phone, auth} · POST /instances/:id/restart|stop ·
 * DELETE /instances/:id · GET /instances/:id/screenshot (PNG) · WS /instances/:id/vnc (RFB) ·
 * POST /instances/:id/send {to, text, quotedId?} · POST /instances/:id/edit {id, text} ·
 * POST /instances/:id/delete {id, everyone?} · GET /instances/:id/history?chats=&perChat= ·
 * POST /instances/:id/media {id} (скачать вложение сообщения) · GET /instances/:id/media/:fileId ·
 * GET|POST /instances/:id/screen-files (файлы для экрана, час) · DELETE …/screen-files/:fileId ·
 * POST …/screen-files/:fileId/attach (подставить в следующее окно выбора файла на экране).
 * Сообщения и их правки/удаления приходят в api событиями (`messages.ts`, Outbox).
 */
export function createMessengerServer(manager: Manager, token: string, files?: ScreenFiles): Server {
  const offers = new FileOffers();
  const authorized = (req: IncomingMessage) => !token || sameToken(String(req.headers[TOKEN_HEADER] ?? ''), token);
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://messenger');
    if (url.pathname === '/health') return json(res, 200, { status: 'ok', instances: manager.list().length });
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/instances') return json(res, 200, manager.list());
    const file = /^\/instances\/([^/]+)\/media\/([0-9a-f]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && file && ID_RE.test(file[1])) {
      const got = await manager.get(file[1])?.readMedia(file[2]);
      if (!got) return json(res, 404, { error: 'нет файла' });
      res.writeHead(200, { 'content-type': got.meta.mime, 'content-length': got.data.length, 'x-file-name': encodeURIComponent(got.meta.name ?? 'file') });
      return res.end(got.data);
    }
    const sf = /^\/instances\/([^/]+)\/screen-files(?:\/([0-9a-f]{24})(\/attach)?)?$/.exec(url.pathname);
    if (sf && ID_RE.test(sf[1]) && files) return screenFiles(req, res, sf[1], sf[2], !!sf[3], files);
    const m = /^\/instances\/([^/]+)(?:\/(restart|stop|screenshot|send|edit|delete|history|media|contact))?$/.exec(url.pathname);
    if (!m || !ID_RE.test(m[1])) return json(res, 404, { error: 'not found' });
    const [, id, action] = m;
    if (req.method === 'PUT' && !action) {
      const body = (await readJson(req)) as { kind?: unknown; phone?: unknown; auth?: unknown };
      const phone = normalizePhone(body.phone);
      if (!isKind(body.kind) || !phone) return json(res, 400, { error: 'kind и phone обязательны' });
      return json(res, 200, await manager.ensure(id, body.kind, phone, body.auth === 'qr' ? 'qr' : 'code'));
    }
    if (req.method === 'DELETE' && !action) {
      await manager.remove(id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (action === 'restart' || action === 'stop')) {
      const st = action === 'restart' ? await manager.restart(id) : await manager.stop(id);
      return st ? json(res, 200, st) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && action === 'contact') {
      const inst = manager.get(id);
      if (!inst) return json(res, 404, { error: 'not found' });
      const b = await readJson(req) as { phone?: unknown };
      if (typeof b.phone !== 'string' || !/^\d{11,15}$/.test(b.phone)) return json(res, 400, { error: 'Некорректный номер' });
      try { return json(res, 200, await inst.contact(b.phone)); }
      catch { return json(res, 422, { error: 'Не удалось проверить контакт: мессенджер недоступен' }); }
    }
    if (req.method === 'POST' && (action === 'send'  || action === 'edit' || action === 'delete' || action === 'media')) {
      const inst = manager.get(id);
      if (!inst) return json(res, 404, { error: 'not found' });
      // Отправка с вложением — base64 до ~64 МБ файла.
      const b = (await readJson(req, action === 'send' ? 96 * 1024 * 1024 : 64 * 1024)) as {
        to?: unknown;
        text?: unknown;
        id?: unknown;
        quotedId?: unknown;
        everyone?: unknown;
        media?: { mime?: unknown; name?: unknown; data?: unknown };
      };
      const text = typeof b.text === 'string' ? b.text : '';
      try {
        if (action === 'send') {
          const media =
            b.media && typeof b.media.data === 'string' && typeof b.media.mime === 'string'
              ? { mime: b.media.mime, name: typeof b.media.name === 'string' ? b.media.name : 'file', data: b.media.data }
              : undefined;
          if (typeof b.to !== 'string' || (!text.trim() && !media)) return json(res, 400, { error: 'to и text (или файл) обязательны' });
          return json(res, 200, await inst.send(b.to, text, typeof b.quotedId === 'string' ? b.quotedId : undefined, media));
        }
        if (action === 'media') {
          if (typeof b.id !== 'string') return json(res, 400, { error: 'id обязателен' });
          const meta = await inst.mediaOf(b.id);
          return meta ? json(res, 200, meta) : json(res, 404, { error: 'вложения нет' });
        }
        if (typeof b.id !== 'string') return json(res, 400, { error: 'id обязателен' });
        if (action === 'edit') return json(res, 200, await inst.edit(b.id, text));
        await inst.remove(b.id, b.everyone !== false);
        return json(res, 200, { ok: true });
      } catch (err) {
        // Ошибка мессенджера (номера нет, правка запрещена) — понятный ответ, а не 500.
        return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (req.method === 'GET' && action === 'history') {
      const inst = manager.get(id);
      if (!inst) return json(res, 404, { error: 'not found' });
      const num = (k: string, d: number, max: number) => Math.min(max, Math.max(1, Number(url.searchParams.get(k)) || d));
      try {
        return json(res, 200, await inst.history(num('chats', 30, 200), num('perChat', 30, 200)));
      } catch (err) {
        return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (req.method === 'GET' && action === 'screenshot') {
      const png = await manager.get(id)?.screenshot().catch(() => null);
      if (!png) return json(res, 404, { error: 'нет экрана' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(png);
    }
    if (req.method === 'GET' && !action) {
      const inst = manager.get(id);
      return inst ? json(res, 200, inst.info) : json(res, 404, { error: 'not found' });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  /** Файлы для экрана мессенджера: загрузить, список, удалить, подставить в окно выбора файла. */
  async function screenFiles(req: IncomingMessage, res: ServerResponse, id: string, fileId: string | undefined, attach: boolean, files: ScreenFiles) {
    const inst = manager.get(id);
    if (!inst) return json(res, 404, { error: 'not found' });
    const state = async () => ({ files: await files.list(id), offer: offers.current(id) });
    if (req.method === 'GET' && !fileId) return json(res, 200, await state());
    if (req.method === 'POST' && !fileId) {
      const b = (await readJson(req, 96 * 1024 * 1024)) as { name?: unknown; mime?: unknown; data?: unknown };
      if (typeof b.data !== 'string') return json(res, 400, { error: 'Нет файла' });
      try {
        await files.put(id, { name: b.name, mime: b.mime, data: b.data });
      } catch (err) {
        return json(res, 422, { error: err instanceof Error ? err.message : String(err) });
      }
      return json(res, 200, await state());
    }
    if (req.method === 'DELETE' && fileId && !attach) {
      if (offers.current(id)?.fileId === fileId) await offers.cancel(id);
      await files.remove(id, fileId);
      return json(res, 200, await state());
    }
    if (req.method === 'POST' && fileId && attach) {
      const f = await files.get(id, fileId);
      if (!f) return json(res, 404, { error: 'Файл удалён: прошёл час или его убрали' });
      const page = inst.filePage();
      if (!page) return json(res, 422, { error: 'Мессенджер не подключён' });
      await offers.offer(id, page, fileId, files.path(id, f), () => files.markAttached(id, fileId));
      return json(res, 200, await state());
    }
    if (req.method === 'DELETE' && !fileId) {
      await offers.cancel(id);
      return json(res, 200, await state());
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  // Экран по VNC: WebSocket ↔ x11vnc экземпляра (тот только на localhost).
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const m = /^\/instances\/([^/]+)\/vnc$/.exec(new URL(req.url ?? '/', 'http://messenger').pathname);
    const inst = m && ID_RE.test(m[1]) ? manager.get(m[1]) : undefined;
    if (!authorized(req) || !inst) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tcp = connect(vncPort(inst.spec.display), '127.0.0.1');
      tcp.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d));
      ws.on('message', (d) => tcp.write(d as Buffer));
      const close = () => {
        tcp.destroy();
        ws.close();
      };
      tcp.on('error', close).on('close', close);
      ws.on('close', close).on('error', close);
    });
  });
  return server;
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
