import type { ReactNode } from 'react';
import { useState } from 'react';
import { Select } from 'antd';
import { CLASSIFICATION_FILTER_MAX, serializeClassificationFilter } from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';
import { useVehicleClassifications } from '../model/useVehicleClassifications';

/**
 * A shared classification filter for requests, history and garage. Multiple positions combine by
 * OR; a whole type and one of its categories are choices in the same field (ADR 0028). A cascade
 * would require another interaction in the phone sheet (ADR 0030).
 *
 * The filter lives with the classifier because both requests and garage use it. Its prompt names
 * a classifier position: the neighbouring vehicle filter names a specific fleet unit (ADR 0098).
 */
export function useVehicleClassificationFilter({
  classifications,
  onChange,
  deferred = false,
}: {
  /** The canonical set string sent to the list request. */
  classifications: string | undefined;
  /**
   * An empty set becomes undefined: an empty query parameter would create a second cache key for
   * the same list.
   */
  onChange: (patch: { classifications?: string }) => void;
  deferred?: boolean;
}): { controls: ReactNode; mobileFilter: FilterDefinition } {
  const [opened, setOpened] = useState(!!classifications);
  const { filterGroups, loading } = useVehicleClassifications(
    !deferred || opened || !!classifications,
  );
  // Keys can be shown immediately; labels arrive with the deferred directory response.
  const value = classifications ? classifications.split(',') : [];
  const pick = (keys: string[]) =>
    onChange({ classifications: serializeClassificationFilter(keys) });

  const controls = (
    <Select
      mode="multiple"
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder="Любой тип ТС"
      // The multi-choice field needs enough width for its tags; the remaining tags collapse to fit.
      style={{ width: 320 }}
      maxTagCount="responsive"
      // Enforce the request limit while choosing, before the server rejects the assembled set.
      maxCount={CLASSIFICATION_FILTER_MAX}
      options={filterGroups}
      loading={loading}
      onOpenChange={(open) => open && setOpened(true)}
      value={value}
      onChange={pick}
    />
  );

  /** The same filter as a phone sheet descriptor (ADR 0030). */
  const mobileFilter: FilterDefinition = {
    kind: 'multiSelect',
    key: 'classification',
    label: 'Тип/категория ТС',
    value,
    options: filterGroups,
    placeholder: 'Любой тип ТС',
    loading,
    onOpen: () => setOpened(true),
    // Four visible tags keep the full-width phone field from covering the other filters.
    maxTagCount: 4,
    maxCount: CLASSIFICATION_FILTER_MAX,
    onChange: pick,
  };

  return { controls, mobileFilter };
}
