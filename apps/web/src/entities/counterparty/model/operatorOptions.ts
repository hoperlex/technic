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
  /**
   * Every link of the site to an operator, whatever the operator's state (what the server counts,
   * snow-removal plan, §3.2). When the site has links but none of them is among `operators` (they
   * all point at inactive or removed operators), it is configured, not unlinked: offering everyone
   * would offer operators the server refuses. Omitted — the old behaviour: no visible link, all.
   */
  siteLinkCount?: number,
) {
  const linked = objectId
    ? operators.filter((operator) => operator.objects.some((object) => object.id === objectId))
    : [];
  const configuredWithoutVisibleLinks = linked.length === 0 && (siteLinkCount ?? 0) > 0;
  const pool = linked.length > 0 ? linked : configuredWithoutVisibleLinks ? [] : operators;
  const options = pool.map((operator) => ({
    value: operator.id,
    label: operator.name,
  }));
  return withSavedOption(options, { id: assigned?.id, name: assigned?.name });
}
