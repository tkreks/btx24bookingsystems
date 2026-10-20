import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // В dev-режиме API — отдельный процесс (`npm run start:dev -w @btx24/api`).
    proxy: { '/api': 'http://localhost:3000' },
  },
});
