import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { writeFileSync } from 'node:fs';

/** Файл, по свежести которого docker healthcheck контейнера worker понимает, что процесс жив. */
export const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/worker-heartbeat';
export const HEARTBEAT_INTERVAL_MS = 15_000;

@Injectable()
export class HeartbeatService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(HeartbeatService.name);
  private timer: NodeJS.Timeout | undefined;

  onModuleInit() {
    this.beat();
    this.timer = setInterval(() => this.beat(), HEARTBEAT_INTERVAL_MS);
    this.logger.log('worker started');
  }

  beat() {
    writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
