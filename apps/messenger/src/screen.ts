import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export const SCREEN = { width: 1280, height: 800 } as const;
export const vncPort = (display: number) => 5900 + display;

/** Виртуальный экран Xvfb `:N` и x11vnc к нему на `5900+N` — общий для браузеров всех мессенджеров. */
export class VirtualScreen {
  private xvfb: ChildProcess | null = null;
  private vnc: ChildProcess | null = null;

  async start(n: number): Promise<void> {
    if (!this.xvfb) {
      // После аварийного перезапуска процесса в том же контейнере остаются блокировка и сокет старого
      // Xvfb: новый не стартует («Server is already active»), а браузер — «Missing X server».
      for (const stale of [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`]) rmSync(stale, { force: true });
      this.xvfb = spawn('Xvfb', [`:${n}`, '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
      for (let i = 0; i < 50 && !existsSync(`/tmp/.X11-unix/X${n}`); i++) await delay(100);
    }
    if (!this.vnc)
      // Только localhost и без пароля: снаружи к нему не подключиться, доступ — через мост api по билету администратора.
      this.vnc = spawn('x11vnc', ['-display', `:${n}`, '-rfbport', String(vncPort(n)), '-localhost', '-nopw', '-forever', '-shared', '-quiet'], { stdio: 'ignore' });
  }

  stop(): void {
    this.vnc?.kill('SIGTERM');
    this.xvfb?.kill('SIGTERM');
    this.vnc = this.xvfb = null;
  }
}
