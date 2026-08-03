import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Те же алиасы слоёв, что у приложения, и из того же tsconfig.json: тест, собранный по другим
  // путям, проверял бы не тот код, который уедет в сборку.
  resolve: { tsconfigPaths: true },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // Компоненты проверяются рендером: поведение выпадающих списков видно только в DOM.
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
  },
});
