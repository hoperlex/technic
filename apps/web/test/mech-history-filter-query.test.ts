import { describe, expect, it } from 'vitest';
import { mechRequestHistoryQuerySchema } from '@technic/contracts';
import {
  MECH_FILTER_FIELDS,
  MECH_HISTORY_FILTER_FIELDS,
  mechHistoryFilterQuery,
} from '../src/pages/mech/mechRequestFilters';

/**
 * What the mechanization journal sends the server about its filters (table, summary and export).
 *
 * Two silent failures are pinned here. A filter the journal draws but never sends does nothing
 * while looking fine (the «Виза» defect). And a filter the history schema does not list is dropped
 * by the server without an error — the schema is not strict — so the field list and the schema have
 * to agree.
 */

/** Every filter field of the list set to a distinct value, plus everything that must stay out. */
const PARAMS = {
  ...Object.fromEntries(MECH_FILTER_FIELDS.map((field) => [field, `value-${field}`])),
  num: 42,
  page: 3,
  pageSize: 50,
  sortBy: 'plannedTo',
  sortOrder: 'asc',
  search: 'text',
};

describe('the journal filter query', () => {
  it('carries every journal filter field and the request number', () => {
    const query = mechHistoryFilterQuery(PARAMS) as Record<string, unknown>;

    for (const field of MECH_HISTORY_FILTER_FIELDS) {
      expect(query[field], field).toBe(`value-${field}`);
    }
    expect(query.num).toBe(42);
    expect(Object.keys(query).sort()).toEqual([...MECH_HISTORY_FILTER_FIELDS, 'num'].sort());
  });

  it('carries neither the page nor the sort, nor the overdue filter of the open list', () => {
    const query = mechHistoryFilterQuery(PARAMS) as Record<string, unknown>;

    for (const absent of ['page', 'pageSize', 'sortBy', 'sortOrder', 'search', 'overdue']) {
      expect(absent in query, absent).toBe(false);
    }
  });

  it('is asked of the server by a field the history schema knows', () => {
    const known = Object.keys(mechRequestHistoryQuerySchema.shape);

    for (const field of MECH_HISTORY_FILTER_FIELDS) {
      expect(known, field).toContain(field);
    }
  });
});
