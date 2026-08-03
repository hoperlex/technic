import { describe, expect, it } from 'vitest';
import { FILE_MAX_COUNT, FILE_MAX_SIZE, fileLimitsHint } from '@shared/config/files';

/**
 * Алиасы слоёв (`@shared/*`, `@entities/*`, …) объявлены в `tsconfig.json`, а vite и vitest читают
 * их через `resolve.tsconfigPaths`. Разойтись эти три инструмента могут молча: `tsc --noEmit`
 * останется зелёным, а сборка или тесты упадут на «cannot resolve». Здесь проверяется резолвинг
 * vitest; за vite отвечает сборка (в графе приложения `@shared/config/files` импортирует
 * `WasteDoneModal`), за tsc — сам typecheck.
 */
describe('алиасы слоёв', () => {
  it('модуль shared доступен по алиасу, а не по относительному пути', () => {
    expect(FILE_MAX_SIZE).toBe(52_428_800);
    expect(FILE_MAX_COUNT).toBe(20);
  });

  it('подпись ограничений собрана из тех же чисел, что и проверки', () => {
    expect(fileLimitsHint).toBe('до 20, до 50 МБ каждый');
  });
});
