import { describe, expect, it } from 'vitest';
import { vehicleRequestKeys } from '../src/entities/vehicle-request';

/**
 * Moving feed presentation must not move its TanStack cache cells. This snapshot records both
 * keys with intentionally different parameter sets: status/number belong only to the feed, while
 * the summary keeps the shared narrowing filters.
 */
describe('vehicle request feed query keys', () => {
  it('keeps the feed and summary cache shapes', () => {
    const shared = {
      objectId: 'obj-1',
      departmentId: 'dep-1',
      requestType: 'special_equipment',
      classifications: 'cvc-1,tvt-2',
      vehicleId: 'vehicle-1',
    };

    expect({
      feed: vehicleRequestKeys.feed({
        page: 2,
        pageSize: 50,
        sortBy: 'term',
        sortOrder: 'asc',
        status: 'new',
        num: 42,
        ...shared,
      }),
      summary: vehicleRequestKeys.summary(shared),
    }).toMatchInlineSnapshot(`
      {
        "feed": [
          "vehicle-requests",
          "feed",
          {
            "classifications": "cvc-1,tvt-2",
            "departmentId": "dep-1",
            "num": 42,
            "objectId": "obj-1",
            "page": 2,
            "pageSize": 50,
            "requestType": "special_equipment",
            "sortBy": "term",
            "sortOrder": "asc",
            "status": "new",
            "vehicleId": "vehicle-1",
          },
        ],
        "summary": [
          "vehicle-requests",
          "summary",
          {
            "classifications": "cvc-1,tvt-2",
            "departmentId": "dep-1",
            "objectId": "obj-1",
            "requestType": "special_equipment",
            "vehicleId": "vehicle-1",
          },
        ],
      }
    `);
  });
});
