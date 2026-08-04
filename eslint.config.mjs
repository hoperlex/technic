// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Слои фронтенда снизу вверх. `shared` разбит на сегменты: направление внутри него задаётся
 * отдельной матрицей (ниже), а для верхних слоёв все сегменты — одинаково «нижний слой».
 * Группами, а не плоским списком: иначе тип `shared` исчезнет из перечисления «что ниже», и
 * обычный `pages → @shared/ui` станет ошибкой.
 */
const SHARED_TYPES = ['shared-config', 'shared-api', 'shared-lib', 'shared-ui'];
/**
 * Слайсы заявок и общий `request` — отдельные типы, а не захват имени слайса: `capture` в элементе
 * меняет способ сопоставления, и с ним правило переставало запрещать импорт соседа (проверено на
 * фикстурах).
 */
const ENTITY_TYPES = ['entity-request', 'entity-request-kin', 'entities'];
const LAYER_GROUPS = [SHARED_TYPES, ENTITY_TYPES, ['features'], ['widgets'], ['pages'], ['app']];

/**
 * Слой видит всё, что ниже него, и только через публичный вход слайса (`index.ts`). Точка входа
 * задаётся тем же правилом: разрешение выдано на `fileInternalPath: 'index.ts'`, поэтому импорт
 * внутреннего модуля чужого слайса под него не подпадает и запрещён умолчанием `disallow`.
 * Отдельное правило `boundaries/entry-point` для этого не нужно — в 7.x оно устарело.
 */
const layerPolicies = LAYER_GROUPS.flatMap((group, index) => {
  const below = LAYER_GROUPS.slice(0, index).flat();
  if (below.length === 0) return [];
  return group.map((layer) => ({
    from: { element: { type: layer } },
    allow: { to: { element: { types: { anyOf: below }, fileInternalPath: 'index.ts' } } },
  }));
});

/**
 * Направление внутри `shared`. Разрешено ровно то, что перечислено: `lib → ui` не разрешается
 * никогда — именно из-за него протокол таблицы и переехал из компонента в `lib`. `api → config`
 * не выдаётся, пока у транспорта нет потребителя констант: полномочие, которое никто не
 * проверяет, только притупляет правило.
 */
const SHARED_MATRIX = {
  'shared-ui': ['shared-lib', 'shared-config'],
  'shared-lib': ['shared-config'],
};

/** Сегменты shared — самостоятельные типы: без этого линт не отличит `lib → ui` от `ui → lib`. */
const sharedElements = SHARED_TYPES.map((type) => ({
  type,
  // Без `/*`: элемент — сам сегмент (каталог `shared/ui`), а не подпапка внутри него. С `/*`
  // элементами считались бы вложенные каталоги, а файлы прямо в сегменте оставались бы вне
  // разметки — и матрица молчала бы.
  pattern: `apps/web/src/shared/${type.replace('shared-', '')}`,
}));

const allElements = [
  ...sharedElements,
  // Порядок важен: частные шаблоны раньше общего `entities/*`, иначе он перехватит их.
  { type: 'entity-request', pattern: 'apps/web/src/entities/request' },
  { type: 'entity-request-kin', pattern: 'apps/web/src/entities/waste-request' },
  { type: 'entity-request-kin', pattern: 'apps/web/src/entities/vehicle-request' },
  ...LAYER_GROUPS.slice(1)
    .flat()
    .filter((type) => !type.startsWith('entity-'))
    .map((type) => ({ type, pattern: `apps/web/src/${type}/*` })),
];

const sharedPolicies = Object.entries(SHARED_MATRIX).map(([from, to]) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: to }, fileInternalPath: 'index.ts' } } },
}));

/**
 * Единственное разрешённое направление между слайсами одного слоя: оба вида заявок берут общее из
 * `request` — статусы, историю, коридоры переходов (ADR 0012, ADR 0015). Положить это в `shared`
 * значило бы протащить домен в фундамент, а продублировать — дать двум копиям разойтись.
 *
 * Разрешение точечное, а не «соседям можно»: обратное направление (`request` → заявки) запрещено,
 * и каждый случай проверяется фикстурой.
 */
const entityKinPolicies = [
  {
    from: { element: { type: 'entity-request-kin' } },
    allow: { to: { element: { type: 'entity-request', fileInternalPath: 'index.ts' } } },
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.{js,mjs,cjs,ts}',
      'apps/api/drizzle/**',
      'temp/**',
      // Фикстуры границ слоёв: заведомо неверные импорты там — материал теста, а не código
      // портала. Их проверяет apps/web/test/boundaries.test.ts своим конфигом.
      'apps/web/test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
  {
    // Правила React — только для фронтенда: в api и worker нет ни хуков, ни компонентов.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      // Хуки не проверялись вовсе: правило вызовов — сразу как ошибка, зависимости эффектов —
      // предупреждением, их разбор не входит в объём этапа 0.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      /*
       * Компонент, объявленный внутри другого компонента, — это новый тип на каждый рендер:
       * React размонтирует и монтирует поддерево заново, а состояние внутри него теряется.
       * `allowAsProps` оставляет разрешённым render-prop: колонки таблицы и строки карточек
       * описываются функциями, возвращающими разметку, и это не объявление компонента — они
       * зовутся из одного и того же места, а не подставляются типом в дерево.
       */
      'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
      // Файл длиннее 400 строк перестаёт читаться целиком — это порог, за которым страницы
      // портала и превратились в монолиты на полторы тысячи строк.
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // Служебные скрипты фронтенда выполняются Node, а не браузером: у них свои глобальные имена.
    files: ['apps/web/scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    /*
     * Вход в сегмент — только его `index.ts`. Отдельным правилом, потому что `boundaries` этого
     * не поймает: старые файлы вне слоёв не классифицированы, политики для них нет, и deep import
     * из них прошёл бы молча.
     */
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@shared/*/*'],
              message: 'Вход в сегмент — только через @shared/<сегмент>, а не вглубь него.',
            },
            {
              group: ['@entities/*/*'],
              message: 'Вход в слайс — только через @entities/<слайс>, а не вглубь него.',
            },
          ],
        },
      ],
    },
  },
  {
    /*
     * Нижний слой не знает правил портала. `no-unknown-dependencies` этого не покажет:
     * `@technic/contracts` — внешний пакет, для линта такой же, как antd. А между тем правила
     * пароля, ФИО и контакта — уже домен, и место им в `entities`, а не в фундаменте.
     */
    files: ['apps/web/src/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@shared/*/*'],
              message: 'Вход в сегмент — только через @shared/<сегмент>, а не вглубь него.',
            },
            {
              group: ['@technic/contracts'],
              message:
                'shared не знает правил портала: доменное правило живёт в entities. Исключение заводится точечно и с обоснованием.',
            },
          ],
        },
      ],
    },
  },
  {
    // Границы слоёв FSD. Пока `src/` разложен не весь, правило молчит на нераспределённых
    // файлах: `boundaries/no-unknown-dependencies` здесь не включается (это делает этап 7),
    // а сами правила проверяются фикстурами в apps/web/test/fixtures/boundaries.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': allElements,
      'import/resolver': {
        typescript: { project: 'apps/web/tsconfig.json' },
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message: 'слой видит только то, что ниже него, и только через index.ts слайса',
          policies: [...layerPolicies, ...sharedPolicies, ...entityKinPolicies],
        },
      ],
    },
  },
  {
    /*
     * Нижние слои обязаны зависеть только от размеченного. Без этого правила `shared` и `entities`
     * могли бы импортировать `api/resources` или `auth/AuthContext` — и линт молчал бы:
     * неклассифицированный элемент под политики не подпадает вовсе. Проверено экспериментом до
     * этапа 1. Верхние слои живут без этой проверки до этапа 7, пока разложены не все.
     */
    files: ['apps/web/src/shared/**/*.{ts,tsx}', 'apps/web/src/entities/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': allElements,
      'import/resolver': { typescript: { project: 'apps/web/tsconfig.json' } },
    },
    rules: {
      // `require: 'element'` — иначе правило молчит: по умолчанию ему достаточно, чтобы цель была
      // известна хоть по одной оси, а файл вне слоёв известен как файл и проверку проходит.
      'boundaries/no-unknown-dependencies': ['error', { require: 'element' }],
    },
  },
);
