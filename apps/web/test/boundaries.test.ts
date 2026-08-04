import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';

/**
 * Правила границ слоёв проверяются на фикстурах, а не на живом коде: живой код разложен не весь, и
 * «ноль ошибок» в нём ничего не доказывает. Проверяется конкретный `ruleId` — правило,
 * подтверждённое «хоть какой-нибудь ошибкой», молча деградирует при смене конфига.
 *
 * Фикстуры прогоняются своим конфигом (`test/fixtures/boundaries/eslint.config.mjs`), повторяющим
 * рабочую разметку: рабочий описывает элементы внутри `src`, и файлы вне его он не классифицирует
 * вовсе.
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

/** Разрешённый импорт — это отсутствие сообщений обоих правил границ, а не «хоть что-то прошло». */
async function expectAllowed(relativePath: string) {
  const rules = await lintFixture(relativePath);
  expect(rules).not.toContain('boundaries/dependencies');
  expect(rules).not.toContain('boundaries/no-unknown-dependencies');
}

describe('границы слоёв', () => {
  it('импорт вниз через публичный вход слайса разрешён', async () => {
    await expectAllowed('features/x/ok-down.ts');
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
    // поэтому импорт внутреннего модуля под него не подпадает и запрещён по умолчанию.
    expect(await lintFixture('features/x/bad-deep.ts')).toContain('boundaries/dependencies');
  });
});

/**
 * Сегменты `shared` — отдельные типы, иначе линт не отличит `lib → ui` от `ui → lib`. Разрешения
 * заданы матрицей, и каждое направление проверяется своим случаем: числа сценариев здесь нет
 * намеренно — пропущенным окажется тот, о ком забыли, а не «восьмой».
 */
describe('границы сегментов shared', () => {
  it('верхний слой видит ui через публичный вход', async () => {
    // Без этой проверки можно безупречно описать внутреннюю матрицу и одновременно отрезать
    // `shared` от всего портала: тип `shared` исчезает из перечисления «что ниже».
    await expectAllowed('features/x/ok-uses-shared.ts');
  });

  it('ui берёт хуки из lib', async () => {
    await expectAllowed('shared/ui/ok-down-to-lib.ts');
  });

  it('lib не смотрит в ui', async () => {
    // Именно из-за этого направления протокол таблицы переехал из компонента в `lib`.
    expect(await lintFixture('shared/lib/bad-up-to-ui.ts')).toContain('boundaries/dependencies');
  });

  it('config ни от чего не зависит', async () => {
    expect(await lintFixture('shared/config/bad-up-to-lib.ts')).toContain(
      'boundaries/dependencies',
    );
  });

  it('shared не зависит от неразмеченного кода', async () => {
    // Пока портал разложен не весь, `api/resources` и подобное остаются вне слоёв. Нижний слой
    // всё равно не имеет права на них ссылаться — иначе домен просочится в фундамент.
    expect(await lintFixture('shared/lib/bad-unknown.ts')).toContain(
      'boundaries/no-unknown-dependencies',
    );
  });
});

/**
 * Слой сущностей. Соседи друг друга не видят — иначе слайсы срастутся и переставать быть
 * самостоятельными начнут незаметно. Единственное исключение — общее двух видов заявок; оно
 * выражено отдельными типами элементов, а не захватом имени слайса: с `capture` правило переставало
 * запрещать импорт соседа вовсе.
 */
describe('границы слоя entities', () => {
  it('сущность берёт нижний слой через публичный вход', async () => {
    await expectAllowed('entities/object/ok-uses-shared.ts');
  });

  it('оба вида заявок берут общее из request', async () => {
    await expectAllowed('entities/waste-request/ok-uses-request.ts');
    await expectAllowed('entities/vehicle-request/ok-uses-request.ts');
  });

  it('сосед по слою запрещён', async () => {
    expect(await lintFixture('entities/object/bad-sibling.ts')).toContain(
      'boundaries/dependencies',
    );
  });

  it('общее не знает о частном: request не видит заявок', async () => {
    // Иначе `request` перестанет быть общим — он начнёт зависеть от того, кто им пользуется.
    expect(await lintFixture('entities/request/bad-uses-waste.ts')).toContain(
      'boundaries/dependencies',
    );
  });

  it('сущность не ссылается на неразмеченный код', async () => {
    expect(await lintFixture('entities/object/bad-uses-legacy.ts')).toContain(
      'boundaries/no-unknown-dependencies',
    );
  });
});
