import { describe, expect, it } from 'vitest';
import { assertPureReexports, checkPureBarrels, pureBarrelRules } from '../scripts/pure-barrels';

describe('узкая политика чистых публичных входов сборки', () => {
  it('проверяет настоящие входы и разрешает только локальные реэкспорты', () => {
    expect(() => checkPureBarrels()).not.toThrow();
    expect(() =>
      assertPureReexports(`export * from './a'; export { b } from './b';`, 'index.ts'),
    ).not.toThrow();
  });

  it.each([
    `import './bootstrap'; export * from './a';`,
    `export const boot = start();`,
    `start(); export * from './a';`,
    `export * from 'external-module';`,
  ])('не разрешает скрыть инициализацию: %s', (code) => {
    expect(() => assertPureReexports(code, 'index.ts')).toThrow('Pure barrel');
  });

  it('не помечает соседние входы или shared/lib с инициализацией dayjs', () => {
    const matches = (path: string) => pureBarrelRules.some(({ test }) => test.test(path));
    expect(matches('/repo/apps/web/src/entities/service-request/index.ts')).toBe(true);
    expect(matches('/repo/apps/web/src/entities/service-request/ui/index.ts')).toBe(false);
    expect(matches('/repo/apps/web/src/shared/lib/index.ts')).toBe(false);
    expect(matches('/repo/apps/web/src/entities/session/index.ts')).toBe(false);
    expect(matches('/repo/packages/contracts/src/permissions.ts')).toBe(false);
  });
});
