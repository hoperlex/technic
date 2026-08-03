// @ts-check
import boundaries from 'eslint-plugin-boundaries';

/**
 * Конфиг для фикстур границ — отдельный от рабочего.
 *
 * Рабочий конфиг классифицирует элементы по путям `apps/web/src/<слой>/*`, а фикстуры лежат вне
 * `src/`: ими он не описывает ничего, правило вернуло бы ноль сообщений, и «зелёный» тест означал
 * бы лишь, что плагин не понял, на что смотрит. Поэтому здесь свои `boundaries/elements` с корнем
 * в каталоге фикстур и свои алиасы для резолвера.
 *
 * `boundaries/no-unknown` включён именно тут: неклассифицированный файл должен падать, а не
 * проходить молча — иначе положительный случай (`ok-down`) ничего не доказывает.
 */

/** Слои от нижнего к верхнему: индекс задаёт, кого слой имеет право видеть. */
const LAYERS = ['shared', 'entities', 'features', 'widgets', 'pages', 'app'];

/** Слой видит всё, что ниже него; себя и соседей по слою — нет. */
const layerPolicies = LAYERS.flatMap((layer, index) => {
  const below = LAYERS.slice(0, index);
  if (below.length === 0) return [];
  return [
    {
      from: { element: { type: layer } },
      allow: {
        // Вход в слайс — только его `index.ts`: внутренние модули снаружи не видны, и импорт
        // мимо публичного входа под это разрешение не подпадает, а значит запрещён по умолчанию.
        to: { element: { types: { anyOf: below }, fileInternalPath: 'index.ts' } },
      },
    },
  ];
});

export default [
  {
    files: ['**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': LAYERS.map((type) => ({ type, pattern: `${type}/*` })),
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
          // Импорты внутри одного слайса правило не проверяет: разрез слайса на модули — его
          // внутреннее дело, снаружи виден только публичный вход.
          policies: layerPolicies,
        },
      ],
      // Файл, который не подошёл ни под один элемент, — не «разрешён», а не описан.
      'boundaries/no-unknown-dependencies': 'error',
    },
  },
];
