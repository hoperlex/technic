import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { checkPureBarrels, pureBarrelRules } from './scripts/pure-barrels';

// Меняется при каждом релизе: deploy-auto пробрасывает короткий commit SHA через BUILD_ID.
// Fallback на таймстамп — только для локального `pnpm build` без переменной.
const BUILD_ID = process.env.BUILD_ID || new Date().toISOString();

// Кладёт /version.json c текущим buildId в dist — клиент сверяет его с вшитым __BUILD_ID__.
const versionFilePlugin = (): Plugin => ({
  name: 'version-file',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ buildId: BUILD_ID }),
    });
  },
});

export default defineConfig({
  plugins: [
    react(),
    versionFilePlugin(),
    { name: 'audit-pure-barrels', buildStart: checkPureBarrels },
  ],
  // Алиасы слоёв берутся из tsconfig.json: один источник истины на tsc, vite и vitest.
  resolve: { tsconfigPaths: true },
  // __BUILD_ID__ вшивается в бандл; хук useVersionCheck сверяет его с /version.json.
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: {
    port: 5173,
    proxy: {
      // dev: проксируем API на локальный backend (single-origin в проде обеспечивает nginx)
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    // Only measured, audited re-export entries are transparent to tree shaking. Do not group
    // vendor chunks by hand or exempt bootstrap modules; the budget counts every static import.
    rolldownOptions: { treeshake: { moduleSideEffects: pureBarrelRules } },
    // The manifest serves measurement, not runtime routing: bundle-size.mjs follows the whole
    // first-screen closure, including shared chunks, instead of guessing from the entry filename.
    manifest: true,
    outDir: 'dist',
    sourcemap: true,
  },
});
