import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Метка сборки: открытая вкладка сравнивает её с /version.json и просит обновиться (session-guard.ts). */
const BUILD_ID = new Date().toISOString();

function versionFile(): Plugin {
  return {
    name: 'btx24-version-file',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: {
    port: 5173,
    // В dev-режиме API — отдельный процесс (`npm run start:dev -w @btx24/api`).
    proxy: { '/api': 'http://localhost:3000' },
  },
});
