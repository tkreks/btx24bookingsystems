import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@btx24/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const dbUp = await this.prisma.isAlive();
    return {
      status: dbUp ? 'ok' : 'degraded',
      version: process.env.npm_package_version ?? '0.0.1',
      db: dbUp ? 'up' : 'down',
      time: new Date().toISOString(),
    };
  }
}
