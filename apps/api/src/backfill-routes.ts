import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { formatVehicleRequestNumber, formatVehicleRouteNumber } from '@technic/contracts';
import { closeDb, db } from './db/client';
import {
  users,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicleRouteRequests,
  vehicleRoutes,
  vehicles,
  vehicleTypes,
  waybillRequests,
  waybills,
} from './db/schema';
import { type BackfillWaybill, pairKey, planBackfill } from './services/route-backfill';

/**
 * Перенос истории путевых листов в рейсы (план `docs/vehicle-routes-plan.md`, §3.4).
 *
 * Запускается между релизами: схема маршрутов уже накатана (миграция 0072), новый API уже
 * работает, а contract-миграция ждёт, пока у каждого листа появится рейс. Поэтому скрипт трогает
 * только легаси — листы с `route_id IS NULL` и заявки, которых ещё нет ни в одном рейсе:
 * заведённое диспетчером за это время не переписывается.
 *
 * Использование:
 *   pnpm --filter @technic/api backfill:routes --check              — отчёт, база не меняется
 *   pnpm --filter @technic/api backfill:routes                      — перенести историю
 *   pnpm --filter @technic/api backfill:routes --clear-orphan-drivers
 *       — обнулить `vehicle_request_assignments.driver_person_id` там, где рейса не бывает
 *         (аренда, спецтехника): без этого шага предохранитель contract-миграции не пройдёт.
 *
 * Повторный запуск безопасен: перенесённое он уже не видит.
 */

interface Diagnostics {
  /** Заявки в листах более чем одной пары «машина + дата» — след отката без аннулирования. */
  multiPair: { requestId: string; displayNumber: string; pairs: string[] }[];
  /** Заявки сразу в нескольких действующих листах — их разбирает человек. Блокирующий пункт. */
  multiActive: { requestId: string; displayNumber: string; waybills: number[] }[];
  /** Водители в назначениях, где рейса не бывает: аренда, спецтехника, тип без бланка. */
  orphanDrivers: { requestId: string; displayNumber: string }[];
  /** Сколько листов ещё без рейса. */
  waybillsWithoutRoute: number;
  /** Заявка одновременно на действующем легаси-листе и в рейсе нового API. Блокирующий пункт. */
  legacyAndRouted: { requestId: string; displayNumber: string }[];
}

/** Легаси-листы: только те, у кого рейса ещё нет. */
async function loadLegacyWaybills(): Promise<BackfillWaybill[]> {
  const rows = await db
    .select({
      id: waybills.id,
      vehicleId: waybills.vehicleId,
      issuedForDate: waybills.issuedForDate,
      number: waybills.number,
      status: waybills.status,
    })
    .from(waybills)
    .where(isNull(waybills.routeId));

  if (rows.length === 0) return [];
  const links = await db
    .select({
      waybillId: waybillRequests.waybillId,
      requestId: waybillRequests.requestId,
      slot: waybillRequests.slot,
    })
    .from(waybillRequests)
    .where(
      inArray(
        waybillRequests.waybillId,
        rows.map((r) => r.id),
      ),
    );

  const byWaybill = new Map<string, { requestId: string; slot: number }[]>();
  for (const link of links) {
    byWaybill.set(link.waybillId, [
      ...(byWaybill.get(link.waybillId) ?? []),
      { requestId: link.requestId, slot: link.slot },
    ]);
  }
  return rows.map((row) => ({
    id: row.id,
    vehicleId: row.vehicleId,
    issuedForDate: row.issuedForDate,
    number: row.number,
    cancelled: row.status === 'cancelled',
    requests: byWaybill.get(row.id) ?? [],
  }));
}

/** Заявки, уже стоящие в рейсах: их перенос не трогает. */
async function loadPlacedRequests(): Promise<Set<string>> {
  const rows = await db
    .select({ requestId: vehicleRouteRequests.requestId })
    .from(vehicleRouteRequests);
  return new Set(rows.map((r) => r.requestId));
}

async function displayNumbers(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: vehicleRequests.id, num: vehicleRequests.num })
    .from(vehicleRequests)
    .where(inArray(vehicleRequests.id, ids));
  return new Map(rows.map((r) => [r.id, formatVehicleRequestNumber(r.num)]));
}

async function diagnose(legacy: BackfillWaybill[], placed: Set<string>): Promise<Diagnostics> {
  const pairsOf = new Map<string, Set<string>>();
  const activeOf = new Map<string, number[]>();
  for (const w of legacy) {
    for (const link of w.requests) {
      pairsOf.set(link.requestId, (pairsOf.get(link.requestId) ?? new Set()).add(pairKey(w)));
      if (!w.cancelled) {
        activeOf.set(link.requestId, [...(activeOf.get(link.requestId) ?? []), w.number]);
      }
    }
  }

  /*
   * Водитель там, где рейса не бывает: у аренды он чужой, у спецтехники и типов без бланка листа
   * нет вовсе. До маршрутов сервер записывал присланного водителя в любое назначение.
   *
   * Колонка спрашивается сырым SQL: миграция 0074 её удаляет, и в схеме drizzle её уже нет — а
   * скрипт работает именно до этой миграции, на базе, где она ещё есть.
   */
  const orphanRows = await db
    .select({ requestId: vehicleRequestAssignments.requestId, num: vehicleRequests.num })
    .from(vehicleRequestAssignments)
    .innerJoin(vehicleRequests, eq(vehicleRequests.id, vehicleRequestAssignments.requestId))
    .innerJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .where(
      and(
        sql`vehicle_request_assignments.driver_person_id IS NOT NULL`,
        sql`(${vehicleRequests.requestType} <> 'freight_transport'
             OR ${vehicles.ownership} <> 'own'
             OR ${vehicleTypes.waybillFormCode} IS NULL)`,
      ),
    );

  const [{ count: withoutRoute } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waybills)
    .where(isNull(waybills.routeId));

  // Окно между релизом 1 и переносом: у заявки есть действующий лист без рейса, а сама она уже
  // лежит в рейсе нового API. Сервер такого не создаёт (Р20а), но состояние возможно у заявок,
  // обработанных в первые секунды после перезапуска.
  const legacyAndRouted = legacy
    .filter((w) => !w.cancelled)
    .flatMap((w) => w.requests.map((l) => l.requestId))
    .filter((id) => placed.has(id));

  const ids = [
    ...new Set([
      ...[...pairsOf.entries()].filter(([, pairs]) => pairs.size > 1).map(([id]) => id),
      ...[...activeOf.entries()].filter(([, nums]) => nums.length > 1).map(([id]) => id),
      ...orphanRows.map((r) => r.requestId),
      ...legacyAndRouted,
    ]),
  ];
  const names = await displayNumbers(ids);
  const named = (id: string) => names.get(id) ?? id;

  return {
    multiPair: [...pairsOf.entries()]
      .filter(([, pairs]) => pairs.size > 1)
      .map(([requestId, pairs]) => ({
        requestId,
        displayNumber: named(requestId),
        pairs: [...pairs],
      })),
    multiActive: [...activeOf.entries()]
      .filter(([, nums]) => nums.length > 1)
      .map(([requestId, nums]) => ({
        requestId,
        displayNumber: named(requestId),
        waybills: nums,
      })),
    orphanDrivers: orphanRows.map((r) => ({
      requestId: r.requestId,
      displayNumber: formatVehicleRequestNumber(r.num),
    })),
    waybillsWithoutRoute: withoutRoute,
    legacyAndRouted: [...new Set(legacyAndRouted)].map((requestId) => ({
      requestId,
      displayNumber: named(requestId),
    })),
  };
}

function printDiagnostics(d: Diagnostics): void {
  console.log(`Листов без рейса: ${d.waybillsWithoutRoute}`);

  if (d.multiPair.length > 0) {
    console.log(`\nЗаявки в листах разных пар «машина + дата» (${d.multiPair.length}):`);
    for (const item of d.multiPair) {
      console.log(`  · ${item.displayNumber}: ${item.pairs.join(', ')}`);
    }
    console.log('  В рейс каждую заберёт один лист — действующий, а при равенстве более поздний.');
  }

  if (d.multiActive.length > 0) {
    console.log(
      `\nБЛОКИРУЕТ. Заявки сразу в нескольких действующих листах (${d.multiActive.length}):`,
    );
    for (const item of d.multiActive) {
      console.log(`  · ${item.displayNumber}: бланки ${item.waybills.join(', ')}`);
    }
    console.log('  Аннулируйте лишний бланк в журнале — перенос до этого не запускается.');
  }

  if (d.legacyAndRouted.length > 0) {
    console.log(
      `\nБЛОКИРУЕТ. Заявка и на действующем листе без рейса, и уже в рейсе (${d.legacyAndRouted.length}):`,
    );
    for (const item of d.legacyAndRouted) console.log(`  · ${item.displayNumber}`);
    console.log('  Аннулируйте легаси-лист либо выньте заявку из рейса — иначе разъедутся оба.');
  }

  if (d.orphanDrivers.length > 0) {
    console.log(`\nВодитель в назначении там, где рейса не бывает (${d.orphanDrivers.length}):`);
    for (const item of d.orphanDrivers) console.log(`  · ${item.displayNumber}`);
    console.log(
      '  Эти значения не переносятся: листа по ним не выписывалось, портал их не показывал.\n' +
        '  Обнулить — `backfill:routes --clear-orphan-drivers` (без этого предохранитель\n' +
        '  contract-миграции не пропустит).',
    );
  }
}

/** Учётка, от чьего имени заводятся рейсы истории: рейс требует автора. */
async function backfillActor(): Promise<string> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(users.createdAt)
    .limit(1);
  if (!row) throw new Error('Нет ни одной учётки администратора — рейсу истории нужен автор');
  return row.id;
}

async function apply(legacy: BackfillWaybill[], placed: Set<string>): Promise<void> {
  const plan = planBackfill(legacy, placed);
  const actorId = await backfillActor();
  let created = 0;

  for (const route of plan.routes) {
    // Транзакция на пару: диспетчер работает в это же время, и рейс, заведённый им на ту же
    // машину и дату, переносу не мешает — тот заводит свой.
    await db.transaction(async (tx) => {
      const canonical = route.canonical;
      const [source] = await tx
        .select({
          driverPersonId: waybills.driverPersonId,
          withTrailer: waybills.withTrailer,
          trailer1Model: waybills.trailer1Model,
          trailer1RegNumber: waybills.trailer1RegNumber,
          trailer2Model: waybills.trailer2Model,
          trailer2RegNumber: waybills.trailer2RegNumber,
          garageNumber: waybills.garageNumber,
          communicationKind: waybills.communicationKind,
          transportationKind: waybills.transportationKind,
          routeId: waybills.routeId,
        })
        .from(waybills)
        .where(eq(waybills.id, canonical.id))
        .for('update');
      // Лист уже перенесён соседним запуском — повторный проход его не трогает.
      if (!source || source.routeId) return;

      const [createdRoute] = await tx
        .insert(vehicleRoutes)
        .values({
          vehicleId: route.vehicleId,
          routeDate: route.routeDate,
          driverPersonId: source.driverPersonId,
          withTrailer: source.withTrailer,
          trailer1Model: source.trailer1Model,
          trailer1RegNumber: source.trailer1RegNumber,
          trailer2Model: source.trailer2Model,
          trailer2RegNumber: source.trailer2RegNumber,
          garageNumber: source.garageNumber,
          communicationKind: source.communicationKind,
          transportationKind: source.transportationKind,
          comment: 'Рейс восстановлен из путевого листа при переносе истории',
          createdBy: actorId,
        })
        .returning({ id: vehicleRoutes.id, num: vehicleRoutes.num });

      await tx
        .update(waybills)
        .set({ routeId: createdRoute!.id })
        .where(and(inArray(waybills.id, route.waybillIds), isNull(waybills.routeId)));

      if (route.requests.length > 0) {
        await tx.insert(vehicleRouteRequests).values(
          route.requests.map((r) => ({
            routeId: createdRoute!.id,
            requestId: r.requestId,
            position: r.position,
          })),
        );
      }
      created += 1;
      console.log(
        `→ ${formatVehicleRouteNumber(createdRoute!.num)}: ${route.routeDate}, ` +
          `листов ${route.waybillIds.length}, талонов ${route.requests.length}`,
      );
    });
  }

  console.log(`\nЗаведено рейсов: ${created}`);

  if (plan.droppedLinks.length > 0) {
    console.log(`\nЗаявки, оставшиеся историей в чужих листах (${plan.droppedLinks.length}):`);
    for (const drop of plan.droppedLinks) {
      console.log(
        `  · ${drop.requestId}: в рейсе ${drop.keptIn}, не в ${drop.droppedFrom.join(', ')}`,
      );
    }
  }
  if (plan.overflow.length > 0) {
    console.log(`\nСостав сверх четырёх талонов (в рейс не попал):`);
    for (const item of plan.overflow) {
      console.log(`  · ${item.key}: ${item.requestIds.join(', ')}`);
    }
  }
}

/** Обнуление водителей там, где рейса не бывает: значений этих не должно было быть вовсе. */
async function clearOrphanDrivers(): Promise<void> {
  // Тоже сырым SQL и по той же причине: колонки нет в схеме, но она есть в базе до миграции 0074.
  const cleared = await db.execute(sql`
    UPDATE vehicle_request_assignments a
    SET driver_person_id = NULL, updated_at = now()
    WHERE a.driver_person_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM vehicle_route_requests rr WHERE rr.request_id = a.request_id)
  `);
  console.log(`Обнулено водителей в назначениях вне рейсов: ${cleared.rowCount ?? 0}`);
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  const clearDrivers = process.argv.includes('--clear-orphan-drivers');

  const legacy = await loadLegacyWaybills();
  const placed = await loadPlacedRequests();
  const diagnostics = await diagnose(legacy, placed);
  printDiagnostics(diagnostics);

  if (checkOnly) {
    console.log('\n--check: база не менялась.');
    return;
  }

  const blocking = diagnostics.multiActive.length + diagnostics.legacyAndRouted.length;
  if (blocking > 0) {
    console.error(`\nПеренос не запущен: сначала разберите ${blocking} блокирующих случаев выше.`);
    process.exitCode = 1;
    return;
  }

  if (clearDrivers) {
    await clearOrphanDrivers();
    return;
  }

  if (legacy.length === 0) {
    console.log('\nПереносить нечего: у всех листов есть рейс.');
    return;
  }
  await apply(legacy, placed);
  console.log(
    '\nДальше: повторите `--check` (листов без рейса должно остаться 0) и,\n' +
      'прочитав отчёт по водителям, прогоните `--clear-orphan-drivers`.',
  );
}

main()
  .catch((e) => {
    console.error('Перенос истории маршрутов не удался:', e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
