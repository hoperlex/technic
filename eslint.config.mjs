// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import boundaries from 'eslint-plugin-boundaries';

/** Слои фронтенда от нижнего к верхнему: индекс задаёт, кого слой имеет право видеть (ADR — черновик структуры). */
const WEB_LAYERS = ['shared', 'entities', 'features', 'widgets', 'pages', 'app'];

/**
 * Слой видит всё, что ниже него, и только через публичный вход слайса (`index.ts`). Точки входа
 * задаются тем же правилом: разрешение выдано на `fileInternalPath: 'index.ts'`, поэтому импорт
 * внутреннего модуля чужого слайса под него не подпадает и запрещён умолчанием `disallow`.
 * Отдельное правило `boundaries/entry-point` для этого не нужно — в 7.x оно объявлено устаревшим.
 */
const webLayerPolicies = WEB_LAYERS.flatMap((layer, index) => {
  const below = WEB_LAYERS.slice(0, index);
  if (below.length === 0) return [];
  return [
    {
      from: { element: { type: layer } },
      allow: {
        to: { element: { types: { anyOf: below }, fileInternalPath: 'index.ts' } },
      },
    },
  ];
});

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
    // Границы слоёв FSD. Пока `src/` разложен не весь, правило молчит на нераспределённых
    // файлах: `boundaries/no-unknown-dependencies` здесь не включается (это делает этап 7),
    // а сами правила проверяются фикстурами в apps/web/test/fixtures/boundaries.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': WEB_LAYERS.map((type) => ({
        type,
        pattern: `apps/web/src/${type}/*`,
      })),
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
          policies: webLayerPolicies,
        },
      ],
    },
  },
);
