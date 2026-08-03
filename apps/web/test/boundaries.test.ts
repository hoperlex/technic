import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

/**
 * Правила границ слоёв проверяются на фикстурах, а не на живом коде: живой код пока разложен не
 * весь, и «ноль ошибок» в нём ничего не доказывает. Проверяется конкретный `ruleId` — правило,
 * подтверждённое «хоть какой-нибудь ошибкой», молча деградирует при смене конфига.
 *
 * Фикстуры прогоняются своим конфигом (`test/fixtures/boundaries/eslint.config.mjs`): рабочий
 * описывает элементы по путям `src/<слой>`, и файлы вне `src/` он не классифицирует вовсе.
 */
// vitest запускается из apps/web (там его конфиг), поэтому путь считается от корня пакета.
const fixturesDir = path.resolve(process.cwd(), 'test/fixtures/boundaries');

async function lintFixture(relativePath: string) {
  const eslint = new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: `${fixturesDir}/eslint.config.mjs`,
  });
  const [result] = await eslint.lintFiles([`${fixturesDir}/${relativePath}`]);
  return (result?.messages ?? []).map((m) => m.ruleId);
}

describe('границы слоёв', () => {
  it('импорт вниз через публичный вход слайса разрешён', async () => {
    const rules = await lintFixture('features/x/ok-down.ts');
    // Ни нарушения границ, ни «файл не классифицирован»: второе означало бы, что конфиг фикстур
    // не описывает это дерево, и остальные три проверки ничего не стоят.
    expect(rules).not.toContain('boundaries/dependencies');
    expect(rules).not.toContain('boundaries/no-unknown-dependencies');
  });

  it('импорт вверх запрещён: entities не знает о features', async () => {
    expect(await lintFixture('entities/object/bad-up.ts')).toContain('boundaries/dependencies');
  });

  it('импорт соседнего слайса того же слоя запрещён', async () => {
    expect(await lintFixture('entities/object/bad-sibling.ts')).toContain(
      'boundaries/dependencies',
    );
  });

  it('deep import внутрь чужого слайса запрещён', async () => {
    // Точка входа выражена тем же правилом: разрешение выдано только на `index.ts` слайса,
    // поэтому импорт внутреннего модуля не подпадает под него и запрещён по умолчанию.
    expect(await lintFixture('features/x/bad-deep.ts')).toContain('boundaries/dependencies');
  });
});
