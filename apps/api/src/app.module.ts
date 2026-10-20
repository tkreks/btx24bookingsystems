import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { validateEnv } from './config/env.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthModule } from './modules/health/health.module.js';

// Раздача собранного фронтенда включается только при заданном WEB_DIST_DIR (prod-контейнер).
const webDist = process.env.WEB_DIST_DIR;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ...(webDist ? [ServeStaticModule.forRoot({ rootPath: webDist, exclude: ['/api/{*path}'] })] : []),
    PrismaModule,
    // Доменные модули — по одному на строку, в алфавитном порядке (снижает merge-конфликты).
    HealthModule,
  ],
})
export class AppModule {}
