import { randomBytes } from 'node:crypto';

/** Билет живёт столько: интерфейс получает его и сразу открывает WebSocket. */
export const VNC_TICKET_TTL_MS = 60_000;

type Ticket = { messengerId: string; portalId: string; userId: number; expiresAt: number };

/**
 * Одноразовые билеты на экран мессенджера по VNC. WebSocket из браузера не несёт заголовков
 * авторизации приложения, поэтому администратор сначала получает билет обычным запросом
 * (B24AuthGuard + постоянный администратор), а WebSocket предъявляет его в адресе.
 */
export class VncTickets {
  private readonly items = new Map<string, Ticket>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(t: Omit<Ticket, 'expiresAt'>): string {
    this.sweep();
    const id = randomBytes(24).toString('hex');
    this.items.set(id, { ...t, expiresAt: this.now() + VNC_TICKET_TTL_MS });
    return id;
  }

  /** Предъявить билет: годен один раз и до истечения срока. */
  take(id: string): Ticket | null {
    const t = this.items.get(id);
    this.items.delete(id);
    return t && t.expiresAt > this.now() ? t : null;
  }

  private sweep() {
    const now = this.now();
    for (const [k, t] of this.items) if (t.expiresAt <= now) this.items.delete(k);
  }
}

/** Один на процесс api: билеты выдаёт контроллер, принимает обработчик upgrade в main.ts. */
export const vncTickets = new VncTickets();
