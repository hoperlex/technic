// @ts-check
import boundaries from 'eslint-plugin-boundaries';

/**
 * Boundary fixtures use a dedicated config instead of the production one.
 *
 * Production descriptors are rooted in `apps/web/src`, while fixtures live outside that tree.
 * Reusing them would classify nothing, so a green test would only prove that the plugin understood
 * no files. This config has its own descriptors, root, and resolver aliases.
 *
 * Both no-unknown rules are intentional: positive fixtures must prove their source classification,
 * and dependencies to unclassified targets must fail instead of passing silently.
 *
 * The descriptors mirror production: shared segments are separate element types, layers are
 * grouped, and flat composition files use file categories. Drift would test imaginary policies.
 */

/** Сегменты нижнего слоя: для верхних слоёв все они одинаково «ниже». */
const SHARED_TYPES = ['shared-config', 'shared-api', 'shared-lib', 'shared-ui'];
/**
 * Слайсы заявок и общий `request` — отдельные типы, а не захват имени: `capture` в элементе меняет
 * способ сопоставления, и с ним правило переставало запрещать импорт соседа (проверено).
 */
const ENTITY_TYPES = ['entity-request', 'entity-request-kin', 'entities'];
const LAYER_GROUPS = [SHARED_TYPES, ENTITY_TYPES, ['features'], ['widgets'], ['pages'], ['app']];

/** Слой видит всё, что ниже него, и только через публичный вход слайса. */
const layerPolicies = LAYER_GROUPS.flatMap((group, index) => {
  const below = LAYER_GROUPS.slice(0, index).flat();
  if (below.length === 0) return [];
  return group.map((layer) => ({
    from: { element: { type: layer } },
    allow: { to: { element: { types: { anyOf: below }, fileInternalPath: 'index.ts' } } },
  }));
});

/** Направление внутри `shared`: `lib → ui` не разрешается никогда. */
const SHARED_MATRIX = {
  'shared-ui': ['shared-lib', 'shared-config'],
  'shared-lib': ['shared-config'],
};

const sharedPolicies = Object.entries(SHARED_MATRIX).map(([from, to]) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: to }, fileInternalPath: 'index.ts' } } },
}));

/** Единственное разрешённое направление между слайсами: оба вида заявок берут общее из `request`. */
const entityKinPolicies = [
  {
    from: { element: { type: 'entity-request-kin' } },
    allow: { to: { element: { type: 'entity-request', fileInternalPath: 'index.ts' } } },
  },
];
const compositionFiles = [
  { category: 'app-root', pattern: 'app/*.{ts,tsx}' },
  {
    category: 'app-root',
    pattern: ['App.ts', 'main.ts', 'theme.ts', 'styles.css'],
  },
];

const compositionPolicies = [
  {
    from: { file: { categories: 'app-root' } },
    allow: { to: { file: { categories: 'app-root' } } },
  },
  {
    from: { file: { categories: 'app-root' } },
    allow: {
      to: {
        element: {
          types: {
            anyOf: [...SHARED_TYPES, ...ENTITY_TYPES, 'features', 'widgets', 'pages', 'app'],
          },
          fileInternalPath: 'index.ts',
        },
      },
    },
  },
];

export default [
  {
    files: ['**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        // Сегмент — сам каталог, без `/*`: иначе элементами считались бы вложенные папки, а файлы
        // прямо в сегменте оставались бы вне разметки, и матрица молчала бы.
        ...SHARED_TYPES.map((type) => ({
          type,
          pattern: `shared/${type.replace('shared-', '')}`,
        })),
        // Порядок важен: частные шаблоны раньше общего `entities/*`, иначе он перехватит их.
        { type: 'entity-request', pattern: 'entities/request' },
        { type: 'entity-request-kin', pattern: 'entities/waste-request' },
        { type: 'entity-request-kin', pattern: 'entities/vehicle-request' },
        ...LAYER_GROUPS.slice(1)
          .flat()
          .filter((type) => !type.startsWith('entity-'))
          .map((type) => ({ type, pattern: `${type}/*` })),
      ],
      'boundaries/files': compositionFiles,
      'boundaries/root-path': import.meta.dirname,
      'import/resolver': {
        typescript: { project: `${import.meta.dirname}/tsconfig.json` },
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message: 'слой видит только то, что ниже него, и только через index.ts слайса',
          // Импорты внутри одного элемента правило не проверяет: разрез на модули — его
          // внутреннее дело, снаружи виден только публичный вход.
          policies: [
            ...layerPolicies,
            ...sharedPolicies,
            ...entityKinPolicies,
            ...compositionPolicies,
          ],
        },
      ],
      'boundaries/no-unknown-files': 'error',
      'boundaries/no-unknown-dependencies': ['error', { require: 'any' }],
    },
  },
];
