import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // Компоненты проверяются рендером: поведение выпадающих списков видно только в DOM.
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
  },
});
