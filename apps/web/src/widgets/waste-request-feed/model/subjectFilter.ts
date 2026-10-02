import type { ContainerKind } from '@technic/contracts';
import type { FilterOption, FilterOptionGroup } from '@shared/ui';

/**
 * The subject filter combines an exact directory row with a whole container kind. The kind keeps
 * its own query parameter; encoding it as a directory id would silently corrupt the API contract.
 */
const SUBJECT_KIND_PREFIX = 'kind:';

export function subjectKindValue(kind: ContainerKind): string {
  return `${SUBJECT_KIND_PREFIX}${kind}`;
}

export function parseSubjectKind(value: string | undefined): ContainerKind | undefined {
  return value?.startsWith(SUBJECT_KIND_PREFIX)
    ? (value.slice(SUBJECT_KIND_PREFIX.length) as ContainerKind)
    : undefined;
}

/** An exact type and a whole kind are mutually exclusive in list parameters. */
export function subjectFilterPatch(value: string | undefined): {
  containerKind: ContainerKind | undefined;
  containerTypeId: string | undefined;
} {
  const kind = parseSubjectKind(value);
  return { containerKind: kind, containerTypeId: kind ? undefined : value };
}

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

/** Omit empty groups so a broad option never leads to an inevitably empty list. */
export function subjectFilterOptions(types: {
  cont: FilterOption[];
  truck: FilterOption[];
}): FilterOptionGroup[] {
  return SUBJECT_GROUPS.filter((group) => types[group.kind].length > 0).map((group) => ({
    label: group.label,
    options: [{ value: subjectKindValue(group.kind), label: group.allLabel }, ...types[group.kind]],
  }));
}
