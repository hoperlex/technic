/**
 * Фабрика ключей запросов: корень сущности → семейство → конкретный ключ с параметрами.
 *
 * Ключи разошлись по экранам строковыми литералами, и одинаковые на вид `['waste-requests', params]`
 * в двух файлах связывало только совпадение букв. Промахнуться мимо чужого ключа легко, поэтому
 * после мутации гасили корень целиком — вместе с изменившимся списком в мусор уходили справочники
 * и сводки, которых мутация не касалась.
 *
 * Здесь ключи сущности описываются одним объектом: имя семейства живёт в единственном месте, а
 * форма ключа у всех одна — `[корень, семейство, …параметры]`. Дальше работает штатное префиксное
 * сравнение TanStack Query: `['objects']` гасит всю сущность, `['objects', 'detail']` — только
 * карточки, `objectKeys.detail('o-1')` — одну. Ничего доменного файл не знает: этим он и годится
 * слою shared.
 */

/** Описатель хвоста ключа: аргументы любые, на выходе — сегменты после корня. */
type KeyTail = (...args: never[]) => readonly unknown[];

/** Набор описателей сущности: имя ключа → чем он продолжается после корня. */
export type QueryKeyDefinitions = Record<string, KeyTail>;

/**
 * Готовый ключ: те же аргументы, что у описателя, но с корнем впереди. Вынесен отдельным типом не
 * для красоты — внутри отображения `[K in keyof TDefs]` компилятор перестаёт видеть в
 * `ReturnType<TDefs[K]>` массив и отказывается раскрывать его в кортеж (TS2574).
 */
type BuiltKey<TRoot extends string, TTail extends KeyTail> = (
  ...args: Parameters<TTail>
) => readonly [TRoot, ...ReturnType<TTail>];

/**
 * Результат фабрики: те же имена с теми же аргументами, но возвращают собранный ключ. Кортеж
 * начинается корнем, поэтому по типу видно, к какой сущности относится ключ, ещё до подстановки
 * в `useQuery`.
 */
export type QueryKeys<TRoot extends string, TDefs extends QueryKeyDefinitions> = {
  /** Корень сущности: им инвалидируют всё её кэшированное разом. */
  readonly root: readonly [TRoot];
} & {
  readonly [K in keyof TDefs]: BuiltKey<TRoot, TDefs[K]>;
};

/**
 * Собирает ключи сущности от её корня.
 *
 * ```ts
 * const objectKeys = createQueryKeys('objects', {
 *   list: (p: ListParams) => ['list', p],
 *   detail: (id: string) => ['detail', id],
 * });
 * objectKeys.root          // ['objects']
 * objectKeys.detail('o-1') // ['objects', 'detail', 'o-1']
 * ```
 *
 * Имя `root` описателям запрещено (`root?: never` у аргумента): иначе описатель затёр бы корень
 * сущности, и инвалидация «всего сразу» молча перестала бы её накрывать.
 */
export function createQueryKeys<TRoot extends string, TDefs extends QueryKeyDefinitions>(
  root: TRoot,
  definitions: TDefs & { root?: never },
): QueryKeys<TRoot, TDefs> {
  const built = Object.entries(definitions).map(
    ([name, tail]: [string, KeyTail]) =>
      // Аргументы здесь уже не проверяются: их сверил вызывающий по типу описателя, а фабрике
      // важно только передать их дальше нетронутыми.
      [name, (...args: never[]) => Object.freeze([root, ...tail(...args)])] as const,
  );

  // Корень кладётся после описателей, а не до: тип уже запретил имя `root`, но из JS такой объект
  // всё же придёт — и пусть он потеряет свой ключ, чем вся сущность останется без инвалидации.
  //
  // Заморозка — не педантизм: `root` один на все обращения, и случайный `push` по нему испортил бы
  // ключи всех запросов сущности разом — не там, где ошиблись, а везде. Типы такое ловят лишь
  // пока ключ не растерял `readonly` по дороге.
  return Object.freeze({
    ...Object.fromEntries(built),
    root: Object.freeze([root]),
  }) as QueryKeys<TRoot, TDefs>;
}
