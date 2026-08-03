// @ts-check
import boundaries from 'eslint-plugin-boundaries';

/**
 * Конфиг для фикстур границ — отдельный от рабочего.
 *
 * Рабочий конфиг классифицирует элементы по путям внутри `apps/web/src`, а фикстуры лежат вне его:
 * ими он не описывает ничего, правило вернуло бы ноль сообщений, и «зелёный» тест означал бы лишь,
 * что плагин не понял, на что смотрит. Поэтому здесь свои `boundaries/elements` с корнем в каталоге
 * фикстур и свои алиасы для резолвера.
 *
 * `boundaries/no-unknown-dependencies` включён именно тут: неклассифицированный файл должен падать,
 * а не проходить молча — иначе положительные случаи ничего не доказывают.
 *
 * Разметка повторяет рабочую: сегменты `shared` — самостоятельные типы, слои описаны группами.
 * Если здесь и там она разойдётся, фикстуры начнут проверять несуществующие правила.
 */

/** Сегменты нижнего слоя: для верхних слоёв все они одинаково «ниже». */
const SHARED_TYPES = ['shared-config', 'shared-api', 'shared-lib', 'shared-ui'];
const LAYER_GROUPS = [SHARED_TYPES, ['entities'], ['features'], ['widgets'], ['pages'], ['app']];

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
        ...LAYER_GROUPS.slice(1)
          .flat()
          .map((type) => ({ type, pattern: `${type}/*` })),
      ],
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
          policies: [...layerPolicies, ...sharedPolicies],
        },
      ],
      'boundaries/no-unknown-dependencies': ['error', { require: 'element' }],
    },
  },
];
