import type { ContainerKind } from '@technic/contracts';
import type { FilterOption, FilterOptionGroup } from '@shared/ui';

/**
 * The "Контейнер / машина" filter answers both "which exact type" and "the whole kind at once".
 * The second is asked more often: "what did dump trucks haul this week" is a question about the
 * kind, not a directory row, and listing types by name would miss the one added yesterday.
 *
 * The kind goes to the server as its own parameter (containerKind), not as a containerTypeId value:
 * that one is a directory row id, and a word mixed into it would silently corrupt the API contract.
 * The prefix lives only inside the field value, and the same prefix parses the choice back.
 */
const SUBJECT_KIND_PREFIX = 'kind:';

export function subjectKindValue(kind: ContainerKind): string {
  return `${SUBJECT_KIND_PREFIX}${kind}`;
}

/** The kind when a whole kind is selected; undefined means a directory row is selected. */
export function parseSubjectKind(value: string | undefined): ContainerKind | undefined {
  return value?.startsWith(SUBJECT_KIND_PREFIX)
    ? (value.slice(SUBJECT_KIND_PREFIX.length) as ContainerKind)
    : undefined;
}

/** An exact type and a whole kind are mutually exclusive in list parameters: one, never both. */
export function subjectFilterPatch(value: string | undefined): {
  containerKind: ContainerKind | undefined;
  containerTypeId: string | undefined;
} {
  const kind = parseSubjectKind(value);
  return { containerKind: kind, containerTypeId: kind ? undefined : value };
}

/** The reverse mapping: how the field shows an already applied filter. */
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
 * Field options: both kinds share one column, so the list is common but grouped, otherwise dump
 * trucks and containers would be mixed. The whole kind is the first item of its group rather than a
 * separate top line, because it answers the same question as the group's items, only broader. An
 * empty kind gets no group at all: "все самосвалы" with no trucks in the directory is an option
 * that always ends in an empty table.
 */
export function subjectFilterOptions(types: {
  cont: FilterOption[];
  truck: FilterOption[];
}): FilterOptionGroup[] {
  return SUBJECT_GROUPS.filter((group) => types[group.kind].length > 0).map((group) => ({
    label: group.label,
    options: [{ value: subjectKindValue(group.kind), label: group.allLabel }, ...types[group.kind]],
  }));
}
