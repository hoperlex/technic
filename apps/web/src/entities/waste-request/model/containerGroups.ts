import { presentGroupLabel, type PresentContainerGroupDto } from '@technic/contracts';

// A present-container group combines its directory type, owner and quantity (ADR 0054). Keeping
// its select encoding and wording here prevents the editor and assignment dialog from describing
// the same physical group differently.

/**
 * Encode type and owner as one selection. Keeping them in separate controls would allow a type
 * from one physical group to be paired with the owner of another; an unknown owner is represented
 * by an empty suffix and remains a valid group.
 */
export function containerGroupKey(
  g: Pick<PresentContainerGroupDto, 'containerTypeId' | 'ownerCounterpartyId'>,
): string {
  return `${g.containerTypeId}:${g.ownerCounterpartyId ?? ''}`;
}

export interface ParsedGroupKey {
  containerTypeId: string;
  ownerCounterpartyId: string | null;
}

export function parseContainerGroupKey(key: string): ParsedGroupKey {
  const [containerTypeId = '', owner = ''] = key.split(':');
  return { containerTypeId, ownerCounterpartyId: owner || null };
}

export function containerGroupOptions(
  groups: readonly PresentContainerGroupDto[],
): { value: string; label: string }[] {
  return groups.map((g) => ({ value: containerGroupKey(g), label: presentGroupLabel(g) }));
}

export function findContainerGroup(
  groups: readonly PresentContainerGroupDto[],
  key: string | undefined,
): PresentContainerGroupDto | undefined {
  return key ? groups.find((g) => containerGroupKey(g) === key) : undefined;
}

/**
 * Describe who already owns containers at the site. An empty site is still information; silence
 * would be indistinguishable from a request that has not loaded.
 */
export function presentGroupsHint(groups: readonly PresentContainerGroupDto[]): string {
  if (groups.length === 0) return 'На объекте сейчас нет контейнеров';
  const parts = groups.map(
    (g) => `${g.ownerName ?? 'оператор не указан'} — ${g.containerTypeName} × ${g.quantity}`,
  );
  return `На объекте сейчас: ${parts.join('; ')}`;
}
