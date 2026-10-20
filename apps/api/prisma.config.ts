import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate`, tsc and unit tests never open a connection, so they must not require
    // DATABASE_URL. Commands that do connect (`migrate dev/deploy`) get the real value from the
    // environment or apps/api/.env.
    url: process.env.DATABASE_URL ?? 'mysql://placeholder:placeholder@localhost:3306/placeholder',
  },
});
