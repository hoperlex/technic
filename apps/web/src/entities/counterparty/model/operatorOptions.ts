import { withSavedOption } from '@shared/lib';

interface OperatorRecord {
  id: string;
  name: string;
  objects: { id: string }[];
}

/**
 * An object with no linked operators falls back to all active operators, matching the server's
 * assignment rule. The saved operator remains labelled after its link or activity was removed.
 */
export function operatorOptionsForObject(
  operators: readonly OperatorRecord[],
  objectId: string | undefined,
  assigned?: { id: string | null; name: string | null },
) {
  const linked = objectId
    ? operators.filter((operator) => operator.objects.some((object) => object.id === objectId))
    : [];
  const options = (linked.length > 0 ? linked : operators).map((operator) => ({
    value: operator.id,
    label: operator.name,
  }));
  return withSavedOption(options, { id: assigned?.id, name: assigned?.name });
}
