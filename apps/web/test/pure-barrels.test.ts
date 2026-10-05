import { describe, expect, it } from 'vitest';
import {
  assertPureReexports,
  checkPureBarrels,
  pureBarrelRules,
  pureClosureProblems,
} from '../scripts/pure-barrels';

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
    `export * from '../other-slice/model';`,
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

  // Tree shaking drops more than the barrel: rolldown discards top-level work of modules reachable
  // only through it. Each shape below was verified to vanish from a production build.
  const closure = (files: Record<string, string>) =>
    pureClosureProblems(
      'index.ts',
      (file) => files[file]!,
      (_from, specifier) => (specifier.startsWith('./') ? specifier.slice(2) + '.ts' : null),
    );

  it('пропускает замыкание из одних объявлений', () => {
    expect(
      closure({
        'index.ts': `export * from './a';`,
        'a.ts': `import { b } from './b'; export const a = () => b;`,
        'b.ts': `import type { T } from './t'; export const b: T = 1; export interface I {}`,
      }),
    ).toEqual([]);
  });

  it.each([
    ['регистрация в соседнем модуле', `export const REGISTRY = new Map(); REGISTRY.set('ru', 1);`],
    ['запись в globalThis', `export const a = 1; (globalThis as any).X = a;`],
    ['импорт ради эффекта', `import './effect'; export const a = 1;`],
    ['стиль', `import './a.css'; export const a = 1;`],
  ])('находит работу, которую выбросит сборка: %s', (_name, code) => {
    const problems = closure({
      'index.ts': `export * from './a';`,
      'a.ts': code,
      'effect.ts': `export {};`,
      'a.css.ts': `export {};`,
    });
    expect(problems.length).toBeGreaterThan(0);
  });
});
