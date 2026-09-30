// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';

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
const PAGE_ROUTE_ENTRY_FILES = [
  'routeModal.tsx',
  'WeeklyRequestPage.tsx',
  'ServiceRequestsPage.tsx',
  'MechRequestsPage.tsx',
  'DriverLayout.tsx',
  'DriverPage.tsx',
  'DriverReadingsPage.tsx',
];
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

const compositionFiles = [
  { category: 'page-support', pattern: 'apps/web/src/pages/captchaPage.tsx', exclusive: true },
  { category: 'page-shell', pattern: 'apps/web/src/pages/*.{ts,tsx}' },
  { category: 'app-root', pattern: 'apps/web/src/app/*.{ts,tsx}' },
  {
    category: 'app-root',
    pattern: [
      'apps/web/src/App.tsx',
      'apps/web/src/main.tsx',
      'apps/web/src/theme.ts',
      'apps/web/src/styles.css',
      'apps/web/src/vite-env.d.ts',
    ],
  },
];

const allElements = [
  ...sharedElements,
  /*
   * Общий пакет правил портала. Он живёт в монорепо, поэтому резолвится в файл, а не в
   * `node_modules`, и без явного описания правило считает его «неизвестным элементом» — как
   * legacy. Для сущностей контракты законны: там и живут статусы, права и подписи. Запрет на них
   * для `shared` — отдельным правилом (`no-restricted-imports`), а не молчанием разметки.
   */
  { type: 'contracts', pattern: 'packages/contracts/**' },
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
  // Контракты доступны всем слоям: это общий словарь портала, а не чей-то слой.
  { from: { element: { type: '*' } }, allow: { to: { element: { type: 'contracts' } } } },
];

/**
 * Root page files are composition shells for their existing page folders. Application roots may
 * render those shells, while the explicit route-entry list keeps App.tsx from reaching arbitrary
 * page internals. File categories close the classifier gap without reshaping page monoliths.
 */
const compositionPolicies = [
  {
    from: { file: { categories: 'page-shell' } },
    allow: { to: { element: { type: 'pages' } } },
  },
  {
    from: { file: { categories: 'page-shell' } },
    allow: { to: { file: { categories: 'page-support' } } },
  },
  {
    from: { file: { categories: { anyOf: ['page-shell', 'page-support'] } } },
    allow: {
      to: {
        element: {
          types: { anyOf: [...SHARED_TYPES, ...ENTITY_TYPES, 'features', 'widgets'] },
          fileInternalPath: 'index.ts',
        },
      },
    },
  },
  {
    from: { file: { categories: { anyOf: ['page-shell', 'page-support'] } } },
    allow: { to: { element: { type: 'contracts' } } },
  },
  {
    from: { element: { type: 'app' } },
    allow: { to: { file: { categories: 'page-shell' } } },
  },
  {
    from: { file: { categories: 'app-root' } },
    allow: { to: { file: { categories: { anyOf: ['page-shell', 'app-root'] } } } },
  },
  {
    from: { file: { categories: 'app-root' } },
    allow: {
      to: {
        element: {
          types: { anyOf: [...SHARED_TYPES, ...ENTITY_TYPES, 'features', 'widgets', 'app'] },
          fileInternalPath: 'index.ts',
        },
      },
    },
  },
  {
    from: { file: { categories: 'app-root' } },
    allow: { to: { element: { type: 'pages', fileInternalPath: PAGE_ROUTE_ENTRY_FILES } } },
  },
  {
    from: { file: { categories: 'app-root' } },
    allow: { to: { element: { type: 'app', fileInternalPath: 'ProtectedRoute.tsx' } } },
  },
  {
    from: { file: { categories: 'app-root' } },
    allow: { to: { element: { type: 'contracts' } } },
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
      // Рабочий каталог системы обслуживания: производное состояние прогона. Там лежат не только
      // отчёты, но и ИЗОЛИРОВАННЫЕ КОПИИ ДЕРЕВА, которыми она проверяет партии, — линт, зашедший
      // туда, проверял бы репозиторий дважды и падал на файлах, которых нет ни в одном tsconfig.
      '.maintenance/**',
      // Agent worktrees are full repository copies, not source owned by this checkout. Scanning
      // them duplicates the project and applies this checkout's tsconfig to another commit.
      '.claude/worktrees/**',

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
    },
  },
  {
    /*
     * Длина мерится только на исходниках портала. Свой блок, а не сужение блока React-правил:
     * вместе с длиной оттуда ушли бы и проверки хуков, а тесты хуки как раз вызывают.
     *
     * `test/` из-под правила выведен осознанно: длинный сценарий читается сверху вниз и в монолит
     * не превращается — он тридцать проверок подряд, а не сплетение состояний, и довод порога к
     * нему не относится.
     */
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      // Файл длиннее 400 строк перестаёт читаться целиком — это порог, за которым страницы
      // портала и превратились в монолиты на полторы тысячи строк.
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    /*
     * Служебные скрипты фронтенда и генераторы документов выполняются Node, а не браузером: у них
     * свои глобальные имена, и без разметки `no-undef` считает каждое из них опечаткой.
     *
     * Набор целиком (`globals.node`), а не перечень имён. Перечень уже подводил: он знал `process`
     * и `console`, а первый же генератор, собирающий ссылку через `URL`, дал три ошибки — и так
     * будет с каждым следующим именем платформы (`Buffer`, `fetch`, `structuredClone`). Список,
     * который надо дописывать вслед за кодом, гарантированно от него отстаёт.
     */
    files: ['apps/web/scripts/**/*.mjs', 'docs/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
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
            {
              // Тот же запрет на слое сценариев. Он не лишний рядом с `boundaries`: файлы вне
              // слоёв (`App.tsx`, `utils/*`) правилом границ не размечены, и глубокий импорт из
              // них прошёл бы молча — а зовут `features` как раз оттуда.
              group: ['@features/*/*'],
              message: 'Вход в слайс — только через @features/<слайс>, а не вглубь него.',
            },
          ],
        },
      ],
    },
  },
  {
    /*
     * Образцы, снятые волной перехода на antd 6 (этап Э8 плана `docs/test-gates-plan.md`).
     * `Space direction` и `Divider type` были самыми частыми — 216 и 1 место, но 6649 из 7254
     * предупреждений за прогон, — и возвращаются они не размышлением, а копипастой соседнего
     * блока. Общее число устаревшего держит бюджет (`antdDeprecated` в quality.mjs), но бюджет
     * говорит «стало на одно больше» и не показывает где; линт называет строку сразу.
     *
     * Правило смотрит на имя элемента, а не на текст: `direction` законен у `Flex`, `type` — у
     * `Button`, `Tag`, `Typography.Text`. `Space.Compact` под селектор не попадает — у него имя
     * не `JSXIdentifier`, — и это правильно: там `direction` свой.
     */
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXOpeningElement[name.name='Space'] > JSXAttribute[name.name='direction']",
          message: 'У Space пропс direction устарел: пишите orientation="vertical" | "horizontal".',
        },
        {
          selector: "JSXOpeningElement[name.name='Divider'] > JSXAttribute[name.name='type']",
          message: 'У Divider пропс type устарел: пишите orientation="vertical" | "horizontal".',
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
    // Layer direction applies to every classified source. Scoped no-unknown rules below decide
    // when an unclassified target is migration debt and when the build must reject it.
    // Dedicated fixtures verify both element and file-category policies.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': allElements,
      'boundaries/files': compositionFiles,
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
          policies: [
            ...layerPolicies,
            ...sharedPolicies,
            ...entityKinPolicies,
            ...compositionPolicies,
          ],
        },
      ],
      'boundaries/no-unknown-files': 'error',
    },
  },
  {
    /*
     * Element-only layers may depend only on classified elements. The dependency policy alone
     * skips unknown targets, so this rule prevents legacy code from leaking back into clean layers.
     *
     * Composition layers use the any-axis rule below because their flat roots are classified as
     * files, while these layers must always resolve imports to elements.
     */
    files: [
      'apps/web/src/shared/**/*.{ts,tsx}',
      'apps/web/src/entities/**/*.{ts,tsx}',
      'apps/web/src/features/**/*.{ts,tsx}',
      'apps/web/src/widgets/**/*.{ts,tsx}',
    ],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': allElements,
      'boundaries/files': compositionFiles,
      'import/resolver': { typescript: { project: 'apps/web/tsconfig.json' } },
    },
    rules: {
      // File categories are reserved for composition roots; these layers must reach an element,
      // not merely a path that happens to have a file classification.
      'boundaries/no-unknown-dependencies': ['error', { require: 'element' }],
    },
  },
  {
    /*
     * Page and app composition target both slice elements and explicitly classified flat files.
     * Requiring either axis still rejects truly unknown targets, which have neither.
     */
    files: [
      'apps/web/src/pages/**/*.{ts,tsx}',
      'apps/web/src/app/**/*.{ts,tsx}',
      'apps/web/src/*.{ts,tsx}',
    ],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': allElements,
      'boundaries/files': compositionFiles,
      'import/resolver': { typescript: { project: 'apps/web/tsconfig.json' } },
    },
    rules: {
      'boundaries/no-unknown-dependencies': ['error', { require: 'any' }],
    },
  },
);
