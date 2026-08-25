import type { ContainerKind } from '@technic/contracts';
import type { FilterOption, FilterOptionGroup } from '@shared/ui';

/**
 * Фильтр «Контейнер / машина» в списке заявок на вывоз: одно поле отвечает и «какой именно тип»,
 * и «весь вид разом».
 *
 * Второе спрашивают чаще: «что возили самосвалами за неделю» — вопрос к виду, а не к позиции
 * справочника, и перечислять типы поимённо значит промахнуться мимо заведённого вчера.
 *
 * Вид уходит на сервер своим параметром (`containerKind`), а не значением `containerTypeId`:
 * тот — идентификатор строки справочника, и подмешанное в него слово перестало бы им быть.
 * Префикс живёт только внутри поля: им же выбранное значение разбирается обратно.
 */
const SUBJECT_KIND_PREFIX = 'kind:';

export function subjectKindValue(kind: ContainerKind): string {
  return `${SUBJECT_KIND_PREFIX}${kind}`;
}

/** Вид, если выбран весь он целиком; иначе `undefined` — значит выбрана позиция справочника. */
export function parseSubjectKind(value: string | undefined): ContainerKind | undefined {
  return value?.startsWith(SUBJECT_KIND_PREFIX)
    ? (value.slice(SUBJECT_KIND_PREFIX.length) as ContainerKind)
    : undefined;
}

/** Что уходит в параметры списка: вид и позиция справочника — всегда одно из двух, не пара. */
export function subjectFilterPatch(value: string | undefined): {
  containerKind: ContainerKind | undefined;
  containerTypeId: string | undefined;
} {
  const kind = parseSubjectKind(value);
  return { containerKind: kind, containerTypeId: kind ? undefined : value };
}

/** Обратный перевод: чем поле показывает уже заданный фильтр. */
export function subjectFilterValue(params: {
  containerKind?: ContainerKind;
  containerTypeId?: string;
}): string | undefined {
  return params.containerKind ? subjectKindValue(params.containerKind) : params.containerTypeId;
}

const SUBJECT_GROUPS = [
  { kind: 'cont', label: 'Контейнеры', allLabel: 'Все контейнеры' },
  { kind: 'truck', label: 'Самосвалы', allLabel: 'Все самосвалы' },
] as const satisfies readonly { kind: ContainerKind; label: string; allLabel: string }[];

/**
 * Список вариантов поля: оба вида соседствуют в одном столбце, поэтому и список общий, но
 * разложен по группам — иначе самосвалы и контейнеры идут вперемешку.
 *
 * Первым пунктом каждой группы — весь её вид. Стоит он внутри группы, а не отдельной строкой
 * сверху, потому что отвечает на тот же вопрос, что и остальные её пункты, только шире. Пустой
 * вид не даёт группы вовсе: «все самосвалы» там, где в справочнике нет ни одного, — вариант,
 * кончающийся пустой таблицей.
 */
export function subjectFilterOptions(types: {
  cont: FilterOption[];
  truck: FilterOption[];
}): FilterOptionGroup[] {
  return SUBJECT_GROUPS.filter((g) => types[g.kind].length > 0).map((g) => ({
    label: g.label,
    options: [{ value: subjectKindValue(g.kind), label: g.allLabel }, ...types[g.kind]],
  }));
}
