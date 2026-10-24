import { request } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Logger } from '@nestjs/common';
import type { MessengerServiceClient } from './messenger-service.client.js';
import { vncTickets } from './vnc-tickets.js';

export const VNC_PATH = '/api/messengers/vnc';
/** Заголовки WebSocket-рукопожатия, которые передаём сервису как есть. */
const PASS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions'];

/**
 * Экран мессенджера по VNC (ADR 0014): `WS /api/messengers/vnc?ticket=…` → сервис messenger
 * `WS /instances/:id/vnc`. Билет одноразовый, выдан постоянному администратору портала этого
 * мессенджера (`POST /api/admin/messengers/:id/vnc-ticket`) или сотруднику с правом писать с номера
 * (`POST /api/messengers/:id/vnc-ticket`, блок дашборда); без билета — 401, сервис не трогаем.
 */
export function attachVncProxy(server: Server, service: MessengerServiceClient): void {
  const log = new Logger('VncProxy');
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://api');
    if (url.pathname !== VNC_PATH) return;
    const ticket = vncTickets.take(url.searchParams.get('ticket') ?? '');
    if (!ticket) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = new URL(`${service.base}/instances/${ticket.messengerId}/vnc`);
    const headers: Record<string, string> = { ...service.headers(), connection: 'Upgrade', upgrade: 'websocket' };
    for (const h of PASS) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
    const out = request({ hostname: target.hostname, port: target.port, path: target.pathname, method: 'GET', headers });
    out.on('upgrade', (res, upstream, upstreamHead) => {
      const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`, ...Object.entries(res.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
      const close = () => {
        upstream.destroy();
        socket.destroy();
      };
      upstream.on('error', close).on('close', close);
      socket.on('error', close).on('close', close);
      log.log(`vnc open: messenger ${ticket.messengerId}, user ${ticket.userId}`);
    });
    out.on('response', (res) => {
      socket.end(`HTTP/1.1 ${res.statusCode ?? 502} Bad Gateway\r\nConnection: close\r\n\r\n`);
    });
    out.on('error', () => socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'));
    out.end();
  });
}
