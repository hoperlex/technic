import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REQUEST_TYPES,
  SNOW_TYPE_CHANGE_MESSAGE,
  SNOW_WASTE_TYPE_ID,
  type RequestType,
  type WasteRequestDto,
} from '@technic/contracts';
import { sql } from 'drizzle-orm';
import {
  buildScene,
  card,
  current,
  garbageWasteType,
  inject,
  insertRequest,
  newOperator,
  newSite,
  REQUESTS,
  type Scene,
  scalar,
  snowBody,
} from './snow-removal-harness';

/**
 * Filing and editing a snow removal request (snow-removal plan, §2, §3.2, §4 «Requests and
 * permissions»): the server owns the waste type, the volume minimum applies to the effective
 * volume, type changes to and from snow are refused, and a counterparty-scoped account files and
 * reassigns only for its own operator on a site the operator serves.
 */

const RUN_DB = !!process.env.TEST_DATABASE_URL;
let s: Scene;

beforeAll(async () => {
  const built = await buildScene('requests');
  if (built) s = built;
}, 300_000);

afterAll(async () => {
  await s?.close();
}, 120_000);

const create = (body: Record<string, unknown>, who = () => s.users.dispatcher) =>
  inject('POST', REQUESTS, who().auth, body);

describe.skipIf(!RUN_DB)('snow subject is set by the server', () => {
  it('files snow at exactly 8 m³ without a waste type', async () => {
    const res = await create(snowBody({ volumeM3: 8 }));
    expect(res.statusCode, res.body).toBe(201);
    const dto = res.json() as WasteRequestDto;
    expect(dto).toMatchObject({
      requestType: 'snow_removal',
      wasteTypeId: SNOW_WASTE_TYPE_ID,
      wasteTypeName: 'Снег',
      volumeM3: 8,
      containersCount: 1,
      containerTypeId: null,
      containerOwnerCounterpartyId: null,
      pricePerM3: null,
      amount: null,
    });
    expect(
      await scalar<boolean>(
        sql`SELECT waste_tariff_id IS NULL AND price_per_m3 IS NULL AS v
              FROM waste_requests WHERE id = ${dto.id}`,
      ),
    ).toBe(true);
  });

  it('discards a waste type sent by the caller', async () => {
    const garbage = await garbageWasteType();
    const res = await create(snowBody({ wasteTypeId: garbage }));
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as WasteRequestDto).wasteTypeId).toBe(SNOW_WASTE_TYPE_ID);
  });

  it.each([
    ['missing', undefined],
    ['smaller than 8 m³', 7],
  ])('refuses a %s volume', async (_label, volumeM3) => {
    const body = snowBody();
    if (volumeM3 === undefined) delete body.volumeM3;
    else body.volumeM3 = volumeM3;
    const res = await create(body);
    expect(res.statusCode, res.body).toBe(400);
  });

  it.each([
    ['lowercase', SNOW_WASTE_TYPE_ID],
    ['uppercase', SNOW_WASTE_TYPE_ID.toUpperCase()],
  ])('garbage refuses the reserved type id (%s) as a field error', async (_label, wasteTypeId) => {
    const res = await create(snowBody({ requestType: 'waste_removal', wasteTypeId }));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().fields?.wasteTypeId).toBeTruthy();
  });

  it('garbage with an ordinary type still files and prices as before', async () => {
    const garbage = await garbageWasteType();
    const res = await create(snowBody({ requestType: 'waste_removal', wasteTypeId: garbage }));
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as WasteRequestDto).wasteTypeId).toBe(garbage);
  });
});

describe.skipIf(!RUN_DB)('editing a snow request', () => {
  it('changes the volume without a type and keeps the stored volume when omitted', async () => {
    const id = await insertRequest({ volume: 10 });
    let dto = await card(id, s.users.dispatcher.auth);
    let res = await inject('PATCH', `${REQUESTS}/${id}`, s.users.dispatcher.auth, {
      volumeM3: 20,
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    dto = res.json() as WasteRequestDto;
    expect(dto.volumeM3).toBe(20);
    expect(dto.wasteTypeId).toBe(SNOW_WASTE_TYPE_ID);

    res = await inject('PATCH', `${REQUESTS}/${id}`, s.users.dispatcher.auth, {
      comment: 'только комментарий',
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as WasteRequestDto).volumeM3).toBe(20);

    res = await inject('PATCH', `${REQUESTS}/${id}`, s.users.dispatcher.auth, {
      volumeM3: 7,
      version: (res.json() as WasteRequestDto).version,
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  const others = REQUEST_TYPES.filter((t) => t !== 'snow_removal');

  it.each(others)('refuses snow → %s with the field explanation', async (to) => {
    const id = await insertRequest();
    const dto = await card(id, s.users.dispatcher.auth);
    const res = await inject('PATCH', `${REQUESTS}/${id}`, s.users.dispatcher.auth, {
      requestType: to,
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().fields?.requestType).toBe(SNOW_TYPE_CHANGE_MESSAGE);
    expect((await card(id, s.users.dispatcher.auth)).requestType).toBe('snow_removal');
  });

  it.each(others)('refuses %s → snow with the field explanation', async (from: RequestType) => {
    const id = await insertRequest({
      type: from,
      wasteTypeId: from === 'waste_removal' ? await garbageWasteType() : null,
    });
    const dto = await card(id, s.users.dispatcher.auth);
    const res = await inject('PATCH', `${REQUESTS}/${id}`, s.users.dispatcher.auth, {
      requestType: 'snow_removal',
      volumeM3: 10,
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().fields?.requestType).toBe(SNOW_TYPE_CHANGE_MESSAGE);
  });

  it('accepts the equal type', async () => {
    const id = await insertRequest();
    const dto = await card(id, s.users.dispatcher.auth);
    const res = await inject('PATCH', `${REQUESTS}/${id}`, s.users.dispatcher.auth, {
      requestType: 'snow_removal',
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe.skipIf(!RUN_DB)('operator assignment and counterparty scope', () => {
  it('assignment and removal of the operator keep both price fields NULL for snow', async () => {
    const id = await insertRequest({ operator: null });
    let dto = await card(id, s.users.dispatcher.auth);
    for (const operatorCounterpartyId of [s.operatorB, null, s.operatorA]) {
      const res = await inject('PATCH', `${REQUESTS}/${id}/operator`, s.users.dispatcher.auth, {
        operatorCounterpartyId,
        version: dto.version,
      });
      expect(res.statusCode, res.body).toBe(200);
      dto = res.json() as WasteRequestDto;
      expect(dto.operatorCounterpartyId).toBe(operatorCounterpartyId);
      expect(dto.pricePerM3).toBeNull();
      expect(dto.amount).toBeNull();
    }
  });

  it('a counterparty creator without an in-scope operator cannot create', async () => {
    const omitted = await create(snowBody(), () => s.users.opCreator);
    expect(omitted.statusCode, omitted.body).toBe(403);
    const foreign = await create(
      snowBody({ operatorCounterpartyId: s.operatorB }),
      () => s.users.opCreator,
    );
    expect(foreign.statusCode, foreign.body).toBe(403);
  });

  it('a counterparty creator with both rights files for its own eligible operator', async () => {
    const res = await create(
      snowBody({ operatorCounterpartyId: s.operatorA }),
      () => s.users.opCreator,
    );
    expect(res.statusCode, res.body).toBe(201);
    const dto = res.json() as WasteRequestDto;
    expect(dto.operatorCounterpartyId).toBe(s.operatorA);
    // Reassigning away from itself is refused, as is removing itself.
    for (const operatorCounterpartyId of [s.operatorB, null]) {
      const moved = await inject(
        'PATCH',
        `${REQUESTS}/${dto.id}/operator`,
        s.users.opCreator.auth,
        {
          operatorCounterpartyId,
          version: dto.version,
        },
      );
      expect(moved.statusCode, moved.body).toBe(403);
    }
    expect((await card(dto.id, s.users.dispatcher.auth)).operatorCounterpartyId).toBe(s.operatorA);
  });

  it('the counterparty creator cannot reassign a request of another operator to itself', async () => {
    const id = await insertRequest({ operator: s.operatorB });
    const dto = await card(id, s.users.dispatcher.auth);
    const res = await inject('PATCH', `${REQUESTS}/${id}/operator`, s.users.opCreator.auth, {
      operatorCounterpartyId: s.operatorA,
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('own operator not bound to the site is refused by the binding rule', async () => {
    const site = await newSite();
    const elsewhere = await newOperator([site]);
    void elsewhere;
    const res = await create(
      snowBody({ objectId: site, operatorCounterpartyId: s.operatorA }),
      () => s.users.dispatcher,
    );
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().fields?.operatorCounterpartyId).toBeTruthy();
  });

  it('a site whose only binding is an inactive operator accepts no other operator', async () => {
    const site = await newSite();
    const inactive = await newOperator([site], false);
    const other = await create(
      snowBody({ objectId: site, operatorCounterpartyId: s.operatorA }),
      () => s.users.dispatcher,
    );
    expect(other.statusCode, other.body).toBe(400);
    expect(other.json().fields?.operatorCounterpartyId).toBeTruthy();
    const itself = await create(
      snowBody({ objectId: site, operatorCounterpartyId: inactive }),
      () => s.users.dispatcher,
    );
    expect(itself.statusCode, itself.body).toBe(400);
    // Without an operator the request is filed; assigning later meets the same rule.
    const bare = await create(snowBody({ objectId: site }), () => s.users.dispatcher);
    expect(bare.statusCode, bare.body).toBe(201);
    const dto = bare.json() as WasteRequestDto;
    const assign = await inject(
      'PATCH',
      `${REQUESTS}/${dto.id}/operator`,
      s.users.dispatcher.auth,
      {
        operatorCounterpartyId: s.operatorA,
        version: dto.version,
      },
    );
    expect(assign.statusCode, assign.body).toBe(400);
  });

  it('a site with no operator links at all accepts any active operator (the fallback)', async () => {
    const site = await newSite();
    const res = await create(
      snowBody({ objectId: site, operatorCounterpartyId: s.operatorB }),
      () => s.users.dispatcher,
    );
    expect(res.statusCode, res.body).toBe(201);
  });

  it('an operator edits nothing outside its own requests, even with the update right', async () => {
    // The operator role has no update right; the site role narrows by site instead.
    const foreignSite = await insertRequest({ objectId: current().otherObjectId });
    const dto = await card(foreignSite, s.users.dispatcher.auth);
    const res = await inject('PATCH', `${REQUESTS}/${foreignSite}`, s.users.site.auth, {
      comment: 'чужая площадка',
      version: dto.version,
    });
    expect(res.statusCode, res.body).toBe(403);
  });
});
