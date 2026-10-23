import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { darkCss } from './src/theme/dark-css.ts';

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

/**
 * Тёмная тема (`import 'virtual:dark-theme.css'`): строится из `styles.css` при сборке и при каждой его
 * правке в dev — см. `src/theme/dark-css.ts`. Отдельного сгенерированного файла нет: не устаревает.
 */
function darkTheme(): Plugin {
  const source = fileURLToPath(new URL('./src/styles.css', import.meta.url));
  // Путь рядом со стилями (файла нет): CSS-плагин Vite обрабатывает его как обычный .css.
  const id = fileURLToPath(new URL('./src/theme/dark-theme.generated.css', import.meta.url));
  return {
    name: 'btx24-dark-theme',
    resolveId: (spec) => (spec === 'virtual:dark-theme.css' ? id : null),
    load(file) {
      if (file !== id) return null;
      this.addWatchFile(source);
      return darkCss(readFileSync(source, 'utf8'));
    },
    handleHotUpdate({ file, server }) {
      if (file !== source) return;
      const mod = server.moduleGraph.getModuleById(id);
      if (mod) server.moduleGraph.invalidateModule(mod);
    },
  };
}

export default defineConfig({
  plugins: [react(), versionFile(), darkTheme()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: {
    port: 5173,
    // В dev-режиме API — отдельный процесс (`npm run start:dev -w @btx24/api`).
    proxy: { '/api': 'http://localhost:3000' },
  },
});
