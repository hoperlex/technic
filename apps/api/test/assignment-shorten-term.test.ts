import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
// Только типы: значения модуля берутся через `await import` уже после того, как выставлено
// окружение, — конфиг сервера читается при импорте и без него падает.
import type * as ShortenTerm from '../src/services/assignment-shorten-term';
import type { AssignmentTerm } from '../src/services/assignment-history';
import type { AssignmentChangeRecord } from '../src/services/assignment-write';

/**
 * Чистая половина общего расчёта изменения срока — гашение групп истории
 * (`docs/vehicle-request-actual-end-date-plan.md`, Р18; `docs/assignment-periods-plan.md`, Д2, В2).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Расчёт переехал из двери правки срока в общий модуль, и пользоваться им
 * будут четыре применяющие ветви: правка срока, закрытие фактической датой и две ветви досрочного
 * завершения. Пока вызывающий был один, критерий Д2 проверялся через его db-сцены — «сокращение
 * гасит группу за новым концом срока». Такой проверки мало для общего расчёта: у неё дорогая цена
 * (миграции, сцена, транзакция) и она молчит про соседние случаи, в которых гасить как раз
 * **нельзя**, — а именно ими критерий и держится. Ошибка здесь не падает: она гасит живое решение
 * о технике или, наоборот, оставляет за сроком дремлющую машину, которая оживёт при следующем
 * продлении в обход Р7.
 *
 * ЗДЕСЬ ТОЛЬКО ЧИСТОЕ. `shortenTermPlan` целиком читает историю, листы и справочники — его
 * доказательство остаётся у db-тестов двери (`assignment-period.db.test.ts`), и второй,
 * приблизительной копией тех же сцен этот файл не является.
 */

let shorten: typeof ShortenTerm;

/*
 * Базы этому файлу не нужно ни строки, но модуль расчёта транзитивно тянет схему и клиент базы, а
 * клиент читает конфиг при импорте. Поэтому окружение выставляется до импорта, а сам импорт
 * отложен — тот же приём и по той же причине, что у `assignment-shadow-compare.test.ts`. Адрес
 * базы заведомо нерабочий: соединения не будет, пул `pg` при создании никуда не ходит.
 */
beforeAll(async () => {
  process.env.NODE_ENV ??= 'test';
  process.env.DATABASE_URL ??= 'postgres://unused:unused@localhost:5432/unused';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.JWT_PRIVATE_KEY_PEM ??= String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM ??= String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  shorten = await import('../src/services/assignment-shorten-term');
});

const term = (dateFrom: string, dateTo: string | null): AssignmentTerm => ({ dateFrom, dateTo });

let counter = 0;

/** Строка истории: читаемые идентификаторы вместо uuid — «B вместо A» понятнее любого ключа. */
function row(
  effectiveDate: string,
  dimension: 'vehicle' | 'driver',
  extra: Partial<AssignmentChangeRecord> = {},
): AssignmentChangeRecord {
  counter += 1;
  return {
    id: `change-${counter}`,
    requestId: 'request-1',
    effectiveDate,
    dimension,
    vehicleId: dimension === 'vehicle' ? `vehicle-${counter}` : null,
    driverPersonId: null,
    driverState: dimension === 'driver' ? 'set' : null,
    origin: 'assignment',
    changeGroupId: `group-${counter}`,
    correctionId: null,
    createdBy: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    supersedesChangeId: null,
    supersededAt: null,
    supersededKind: null,
    ...extra,
  };
}

describe('гасимые группы при сокращении срока (Д2)', () => {
  it('vehicle-строка внутри прежнего срока и за новым концом — гасится вместе со спутником', () => {
    const vehicle = row('2026-08-20', 'vehicle', { changeGroupId: 'g-tail' });
    const driver = row('2026-08-20', 'driver', {
      changeGroupId: 'g-tail',
      driverPersonId: 'person-1',
    });
    const groups = shorten.cancelGroupsOf(
      [row('2026-08-01', 'vehicle'), vehicle, driver],
      term('2026-08-01', '2026-08-31'),
      term('2026-08-01', '2026-08-10'),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.changeGroupId).toBe('g-tail');
    // Состав целиком и обеих шкал: гашение групповое (В2) — вместе с машиной уходит её машинист.
    expect(groups[0]!.rows.map((r) => r.dimension)).toEqual(['driver', 'vehicle']);
    // Ядру группа адресуется **vehicle**-строкой, а не первой попавшейся: гасится вся группа, но
    // якорем стоит машина. Живая строка адресуется идентификатором; у строки, которую история
    // материализует той же транзакцией, его ещё нет — там адрес логический (`assignmentChangeTargetOf`).
    expect(groups[0]!.target).toEqual({ kind: 'cancel', target: { changeId: vehicle.id } });
  });

  it('строка расчётной истории адресуется логическим ключом, а не идентификатором', () => {
    // У заявки, историю которой материализует та же транзакция, `changeId` появится только на
    // шаге 11 — команда же считалась шагом 5, по строкам, которых в базе ещё нет.
    const groups = shorten.cancelGroupsOf(
      [row('2026-08-20', 'vehicle', { id: 'planned:v-1', changeGroupId: 'g-tail' })],
      term('2026-08-01', '2026-08-31'),
      term('2026-08-01', '2026-08-10'),
    );
    expect(groups[0]!.target).toEqual({
      kind: 'cancel',
      target: { dimension: 'vehicle', effectiveDate: '2026-08-20' },
    });
  });

  it('продление не гасит ничего: гасить нечего, пока конец срока не поехал назад', () => {
    expect(
      shorten.cancelGroupsOf(
        [row('2026-08-20', 'vehicle')],
        term('2026-08-01', '2026-08-31'),
        term('2026-08-01', '2026-09-30'),
      ),
    ).toEqual([]);
  });

  it('группа только со шкалой `driver` за новым концом гасится наравне с машиной', () => {
    /*
     * Прежде здесь стояло обратное ожидание — «не гасится, послабление Р24». Оно снято по решению
     * заказчика: гасятся **любые** решения за новым концом срока, независимо от шкалы. Послабление
     * Р24 отвечает на другой вопрос — можно ли **поставить** машиниста за концом срока и не
     * выписывать под него бумагу; здесь же решается судьба решения, которое стояло **внутри** срока
     * и которое команда только что вынесла наружу. Оставь его дверь непогашенным — оно оживёт при
     * первом же продлении после отката, вопреки Р14, и в работу вернулся бы субботний сменщик,
     * которого никто заново не называл.
     */
    const groups = shorten.cancelGroupsOf(
      [row('2026-08-20', 'driver', { changeGroupId: 'g-swap', driverPersonId: 'person-1' })],
      term('2026-08-01', '2026-08-31'),
      term('2026-08-01', '2026-08-10'),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.changeGroupId).toBe('g-swap');
    // Якорь у безмашинной группы — её единственная строка: `vehicle`-строки в ней нет вовсе, и
    // адресуется группа тем, что есть. Гасится всё равно вся группа по `change_group_id`.
    expect(groups[0]!.rows.map((r) => r.dimension)).toEqual(['driver']);
    expect(groups[0]!.target).toEqual({
      kind: 'cancel',
      target: { changeId: groups[0]!.rows[0]!.id },
    });
  });

  it('дремлющая `driver`-группа за старым концом сокращению по-прежнему не мешает', () => {
    /*
     * Граница нового правила: сняли условие по шкале, а не условие по дате. Машинист, поставленный
     * на день после прежнего `dateTo`, дремал ещё до команды (Р24) — сокращение его не выносило за
     * срок и гасить его не за что, ровно как и такую же машину (§13).
     */
    expect(
      shorten.cancelGroupsOf(
        [row('2026-09-01', 'driver', { driverPersonId: 'person-1' })],
        term('2026-08-01', '2026-08-31'),
        term('2026-08-01', '2026-08-10'),
      ),
    ).toEqual([]);
  });

  it('дремлющая группа за старым концом сокращению не мешает', () => {
    // Решение хвоста стоит на `dateTo + 1` и было дремлющим ещё до команды: гасить его правкой
    // срока не за что (§13).
    expect(
      shorten.cancelGroupsOf(
        [row('2026-09-01', 'vehicle')],
        term('2026-08-01', '2026-08-31'),
        term('2026-08-01', '2026-08-10'),
      ),
    ).toEqual([]);
  });

  it('погашенная строка в счёт не идёт: гасить дважды нечего', () => {
    expect(
      shorten.cancelGroupsOf(
        [row('2026-08-20', 'vehicle', { supersededAt: new Date('2026-08-05T00:00:00Z') })],
        term('2026-08-01', '2026-08-31'),
        term('2026-08-01', '2026-08-10'),
      ),
    ).toEqual([]);
  });

  it('сдвиг начала срока вперёд не гасит строку левее нового начала', () => {
    // Она продолжает задавать состав первого дня: свёртка читает последнее изменение **до** даты.
    expect(
      shorten.cancelGroupsOf(
        [row('2026-08-01', 'vehicle')],
        term('2026-08-01', '2026-08-31'),
        term('2026-08-15', '2026-08-31'),
      ),
    ).toEqual([]);
  });

  it('однодневный срок читается как `coalesce(date_to, date_from)`', () => {
    const groups = shorten.cancelGroupsOf(
      [row('2026-08-20', 'vehicle', { changeGroupId: 'g-tail' })],
      term('2026-08-01', '2026-08-31'),
      term('2026-08-01', null),
    );
    expect(groups.map((g) => g.changeGroupId)).toEqual(['g-tail']);
  });

  it('группы идут по возрастанию даты — так их читает человек в предпросмотре', () => {
    const groups = shorten.cancelGroupsOf(
      [
        row('2026-08-25', 'vehicle', { changeGroupId: 'g-late' }),
        row('2026-08-15', 'vehicle', { changeGroupId: 'g-early' }),
      ],
      term('2026-08-01', '2026-08-31'),
      term('2026-08-01', '2026-08-10'),
    );
    expect(groups.map((g) => g.changeGroupId)).toEqual(['g-early', 'g-late']);
  });
});

describe('содержание гасимых групп для отпечатка', () => {
  it('хешируется значениями, а не идентификаторами', () => {
    const groups = shorten.cancelGroupsOf(
      [
        row('2026-08-20', 'vehicle', { changeGroupId: 'g-tail', vehicleId: 'vehicle-A' }),
        row('2026-08-20', 'driver', { changeGroupId: 'g-tail', driverPersonId: 'person-1' }),
      ],
      term('2026-08-01', '2026-08-31'),
      term('2026-08-01', '2026-08-10'),
    );
    /*
     * Ни `id` строки, ни `changeGroupId` в содержание не входят: у истории, которую материализует
     * та же транзакция, идентификаторов ещё нет вовсе, а состав группы человек подтверждает по
     * составу. Смена члена группы между предпросмотром и командой обязана дать 422 «список
     * изменился», а не пройти молча.
     */
    expect(shorten.cancelGroupsShape(groups)).toEqual([
      [
        {
          effectiveDate: '2026-08-20',
          dimension: 'driver',
          vehicleId: null,
          driverPersonId: 'person-1',
          driverState: 'set',
          origin: 'assignment',
        },
        {
          effectiveDate: '2026-08-20',
          dimension: 'vehicle',
          vehicleId: 'vehicle-A',
          driverPersonId: null,
          driverState: null,
          origin: 'assignment',
        },
      ],
    ]);
  });

  it('замена машины в группе меняет содержание — значит и отпечаток', () => {
    const before = shorten.cancelGroupsOf(
      [row('2026-08-20', 'vehicle', { changeGroupId: 'g', vehicleId: 'vehicle-A' })],
      term('2026-08-01', '2026-08-31'),
      term('2026-08-01', '2026-08-10'),
    );
    const after = shorten.cancelGroupsOf(
      [row('2026-08-20', 'vehicle', { changeGroupId: 'g', vehicleId: 'vehicle-B' })],
      term('2026-08-01', '2026-08-31'),
      term('2026-08-01', '2026-08-10'),
    );
    expect(shorten.cancelGroupsShape(before)).not.toEqual(shorten.cancelGroupsShape(after));
  });
});
