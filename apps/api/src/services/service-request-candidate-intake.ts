import type { FastifyRequest } from 'fastify';
import { and, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  formatServiceRequestNumber,
  OFFICE_EQUIPMENT_CANDIDATE_CONFLICT_CODES,
  officeEquipmentTitle,
  type CreateServiceRequestInput,
} from '@technic/contracts';
import { db } from '../db/client';
import { officeEquipment, officeEquipmentCandidates, serviceRequests } from '../db/schema';
import type { Principal } from '../auth/principal';
import { officeEquipmentScopeWhere, serviceRequestVisibilityWhere } from '../lib/access';
import { sha256hex } from '../lib/crypto';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';

/**
 * ПРИЁМ СООБЩЕНИЯ О ТЕХНИКЕ, КОТОРОЙ НЕТ В СПРАВОЧНИКЕ (план
 * `docs/office-equipment-candidate-plan.md`, Р2, Р10, §8 «Идемпотентность заведения»).
 *
 * Здесь живёт всё, что у заведения заявки с кандидатом СВОЕГО: два рубежа защиты от дублей и ключ
 * идемпотентности. Сам разбор предмета и вставка пары остались в маршруте заявок рядом с двумя
 * другими способами назвать предмет — иначе третий читался бы «где-то в другом файле», а сравнить
 * три ветви глазами было бы негде.
 *
 * ТРИ РУБЕЖА ОТВЕЧАЮТ НА РАЗНЫЕ ВОПРОСЫ, и путать их нельзя (Р10):
 *
 *   * **рубеж 1** — «а нет ли такого аппарата в парке уже сегодня»: живая карточка с тем же
 *     серийным или инвентарным номером ищется ПО ВСЕМУ ПАРКУ, мимо области. Заявитель мог не найти
 *     аппарат именно потому, что тот числится за чужой площадкой или снят с эксплуатации, — и
 *     ответ ему нужен разный в каждом из трёх случаев;
 *   * **рубеж 2** — «а не сообщил ли о нём кто-то минуту назад»: его держат частичные уникальные
 *     индексы ожидающих кандидатов, а не `SELECT` маршрута. Двое в одну минуту проходят любую
 *     проверку чтением, и отбивает второго только база;
 *   * **рубеж 3** — гонка при РЕШЕНИИ проверяющего (Э4), и его здесь нет вовсе.
 *
 * ИДЕМПОТЕНТНОСТЬ — ПРИЁМОМ ЗАКУПКИ (`services/office-equipment-purchases.ts`, её Р17), и это
 * заимствование, а не совпадение: ключ описывает ПОПЫТКУ отправки, отпечаток — саму команду, пара
 * «автор + ключ» уникальна, а гонка ключа разбирается снаружи прерванной транзакции по ИМЕНИ
 * ограничения. Отличие ровно одно и оно названо в §8: у кандидата уникальных индексов, способных
 * сработать на одном и том же теле, ТРИ, а PostgreSQL не обещает, какой сообщит первым, — поэтому
 * разбор смотрит на три имени и в любом из них сначала перечитывает победителя по ключу.
 */

/** Имена, по которым маршрут узнаёт свои `23505`. Заданы руками в миграции ровно ради этого. */
export const CANDIDATE_IDEMPOTENCY_CONSTRAINT = 'office_equipment_candidates_idempotency_unique';
export const CANDIDATE_SERIAL_PENDING_CONSTRAINT =
  'office_equipment_candidates_serial_pending_unique';
export const CANDIDATE_INVENTORY_PENDING_CONSTRAINT =
  'office_equipment_candidates_inventory_pending_unique';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Пара номеров как их прислал заявитель: оба уже обрезаны схемой, любой из двух бывает пустым. */
export interface CandidateNumbers {
  serialNumber: string;
  inventoryNumber: string;
}

/**
 * Ключ идемпотентности заголовком — тем же транспортом, что у закупки и кабинета водителя
 * (ADR 0103).
 *
 * ОБЯЗАТЕЛЕН, НО ТОЛЬКО У ВЕТКИ КАНДИДАТА, и это не половинчатость. Заведение заявки — ручка
 * старая, у неё есть клиенты и интеграции, которые о заголовке не знают, и потребуй его весь
 * `POST /service-requests`, выпуск сломал бы две работающие двери ради третьей. У самой же ветки
 * кандидата клиентов нет вовсе — она заводится этим выпуском, — а необязательный ключ означал бы
 * защиту, которая работает у того, кто её попросил, то есть не работает: колонки
 * `idempotency_key`/`idempotency_fingerprint` объявлены `NOT NULL` ровно поэтому.
 *
 * `uuid`, а не свободная строка: ключ порождает портал на попытку отправки, тип отбивает мусор в
 * заголовке раньше маршрута, и он же стоит типом колонки.
 */
export function candidateIntakeKeyOf(req: FastifyRequest): string {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    throw err.badRequest(
      'Сообщение о технике отправляется с заголовком Idempotency-Key — обновите страницу и повторите',
    );
  }
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw err.badRequest('Некорректный Idempotency-Key');
  return parsed.data;
}

/**
 * Тело заведения, приведённое к одному виду ДО отпечатка (§8).
 *
 * НОРМАЛИЗУЕТСЯ ВСЁ ТЕЛО, а не один кандидат, и это требование плана дословно: пара «кандидат +
 * заявка» создаётся одной командой, и «та же попытка» означает «та же ЗАЯВКА с тем же сообщением».
 * Перепиши человек описание, не тронув кандидата, — это другая команда, и возвращать ему прежнюю
 * заявку молча нельзя.
 *
 * Множества идентификаторов сортируются и дедуплицируются: `fileIds` приходят в том порядке, в
 * каком человек прикладывал файлы, и переставленные местами вложения ТОЙ ЖЕ заявки дали бы другой
 * отпечаток — то есть честный повтор потерянного ответа получил бы 409 «ключ занят другой
 * командой».
 *
 * НЕОБЯЗАТЕЛЬНЫЕ ЗНАЧЕНИЯ СВОДЯТСЯ К ОДНОМУ ВИДУ по той же причине, но с оговоркой: `null` и
 * «поля нет» у заказчика — РАЗНЫЕ ответы для маршрута (Р12 ADR 0085), а для отпечатка разные тела
 * обязаны давать разные отпечатки. Поэтому пустота здесь различается: `undefined` остаётся
 * `undefined` и в JSON не попадает вовсе, а `null` попадает.
 *
 * РЕГИСТР НОМЕРОВ НЕ ПРИВОДИТСЯ, хотя индексы ожидающих сравнивают номера через `upper(btrim(…))`.
 * Это осознанно: отпечаток описывает попытку ОТПРАВКИ ФОРМЫ, а не номер. Исправил человек `s/n` на
 * `S/N` — он изменил форму, и портал берёт на неё новый ключ; совпади отпечатки, сервер вернул бы
 * ему прежнюю пару, то есть подтвердил бы команду, которой не было.
 */
function normalizedBody(input: CreateServiceRequestInput): unknown {
  const candidate = input.equipmentCandidate;
  return {
    kind: input.kind ?? null,
    description: input.description.trim(),
    comment: input.comment.trim(),
    responsibleName: input.responsibleName.trim(),
    responsiblePhone: input.responsiblePhone.trim(),
    officeEquipmentId: input.officeEquipmentId ?? null,
    objectId: input.objectId ?? null,
    objectOverridden: input.objectOverridden,
    customerDepartmentId: input.customerDepartmentId,
    requesterDepartmentId: input.requesterDepartmentId,
    requesterObjectId: input.requesterObjectId,
    warrantyClaim: input.warrantyClaim?.source ?? null,
    isUrgent: input.isUrgent,
    urgencyReason: input.urgencyReason.trim(),
    fileIds: [...new Set(input.fileIds)].sort(),
    consumables: [...(input.consumables ?? [])]
      .map((line) => ({ ...line }))
      .sort((a, b) => a.consumableId.localeCompare(b.consumableId)),
    candidate: candidate
      ? {
          equipmentTypeId: candidate.equipmentTypeId,
          declaredModel: candidate.declaredModel.trim(),
          serialNumber: candidate.serialNumber.trim(),
          inventoryNumber: candidate.inventoryNumber.trim(),
          objectId: candidate.objectId,
          location: candidate.location.trim(),
          comment: candidate.comment.trim(),
        }
      : null,
  };
}

/**
 * Отпечаток тела отправки. Запись — та же, что у закупки и у кабинета водителя (`submitFingerprint`):
 * версия впереди, чтобы смена состава полей однажды не выдала старый отпечаток за новый.
 */
export function candidateIntakeFingerprint(input: CreateServiceRequestInput): string {
  return `v1:${sha256hex(JSON.stringify(normalizedBody(input)))}`;
}

/**
 * Уже созданная пара под тем же ключом. `requestId` пуст, если заявку успели снести необратимым
 * `records.purge` вместе с её кандидатом: ключ занят тем, чего уже нет, и повтором это не является.
 */
export interface CandidateIntakePair {
  candidateId: string;
  requestId: string | null;
  fingerprint: string;
}

/**
 * Что уже создано под парой «автор + ключ» (§8, шаги «спросить ключ» и «перечитать победителя»).
 *
 * ПАРА, А НЕ КЛЮЧ САМ ПО СЕБЕ: ключ описывает попытку КОНКРЕТНОГО человека, и совпадение UUID у
 * двоих (пусть невероятное) не должно превращать чужую заявку в «повтор». Ровно этой парой объявлено
 * и уникальное ограничение.
 *
 * Заявка берётся `leftJoin`, а не вторым запросом: связь 1:1 держит частичный уникальный индекс, и
 * «кандидат есть, а заявки нет» — единственное законное расхождение, о котором вызывающий обязан
 * узнать, а не получить пустоту вместо ответа.
 */
async function findCandidateIntakeByKey(
  runner: Tx | typeof db,
  actorId: string,
  key: string,
): Promise<CandidateIntakePair | null> {
  const [row] = await runner
    .select({
      candidateId: officeEquipmentCandidates.id,
      fingerprint: officeEquipmentCandidates.idempotencyFingerprint,
      requestId: serviceRequests.id,
    })
    .from(officeEquipmentCandidates)
    .leftJoin(
      serviceRequests,
      eq(serviceRequests.equipmentCandidateId, officeEquipmentCandidates.id),
    )
    .where(
      and(
        eq(officeEquipmentCandidates.createdBy, actorId),
        eq(officeEquipmentCandidates.idempotencyKey, key),
      ),
    );
  return row ?? null;
}

/**
 * «Этот ключ занят другой командой» — отдельным кодом, а не общим `version_conflict` (приём
 * закупки). Исход у него другой: «устарели данные» лечится повторной отправкой со свежим снимком, а
 * занятый ключ означает, что портал переиспользовал UUID попытки под изменённое тело, — повторять
 * тут нечего, надо взять новый ключ.
 */
function idempotencyConflict(): never {
  throw err.conflict('Под этим ключом отправки уже принята другая заявка', {
    code: OFFICE_EQUIPMENT_CANDIDATE_CONFLICT_CODES.idempotency,
  });
}

/**
 * ПОВТОР ЛИ ЭТО (§8): пара под тем же ключом с тем же отпечатком — «да», и маршрут возвращает
 * прежнюю заявку, ничего больше не делая.
 *
 * Один вход на оба места, где вопрос задаётся, — до транзакции и после её отката по `23505`, — и
 * это не экономия строк: у ответа «нет» две причины, и обе кончаются ОТКАЗОМ, а не заведением
 * второй пары. Отпечаток другой — под ключом уже принята другая команда; заявки под кандидатом нет
 * — ключ занят тем, чего уже нет (необратимый `purge` унёс пару целиком). Разъедься эти два места,
 * одно из них однажды ответило бы «не повтор» и завело бы вторую пару под занятым ключом.
 */
export async function findIntakeRepeat(
  p: Principal,
  key: string,
  fingerprint: string,
): Promise<string | null> {
  const seen = await findCandidateIntakeByKey(db, p.id, key);
  if (!seen) return null;
  if (seen.fingerprint !== fingerprint || !seen.requestId) idempotencyConflict();
  return seen.requestId;
}

/** Сравнение номеров — как в уникальных индексах: без регистра и без крайних пробелов. */
function sameNumberSql(column: AnyColumn, value: string): SQL {
  return sql`upper(btrim(${column})) = upper(btrim(${value}))`;
}

/**
 * РУБЕЖ 1: аппарат с этим номером уже есть в парке (Р10).
 *
 * ИЩЕТСЯ ПО ВСЕМУ ПАРКУ, МИМО ОБЛАСТИ, и это главное решение рубежа. Заявитель не нашёл аппарат
 * ровно по двум причинам: либо тот числится за чужой площадкой (и в его селекторе его нет), либо
 * снят с эксплуатации (и селектор его прячет). Ищи мы в его области — рубеж молчал бы именно в тех
 * случаях, ради которых заведён, и очередь проверки наполнилась бы сообщениями об уже заведённой
 * технике.
 *
 * ТРИ РЕДАКЦИИ ОТКАЗА, потому что дальше человек делает три РАЗНЫХ действия:
 *
 *   * карточка активна и в его области — он просто её не нашёл (поиск, страница списка): ответ
 *     называет аппарат и отдаёт `officeEquipmentId`, портал подставляет единицу в поле, и заявка
 *     продолжается тем же нажатием;
 *   * карточка неактивна и в его области — идти к оператору: `officeEquipmentId` НЕ отдаётся, и
 *     это не экономия. Активный селектор его не покажет, а сервер всё равно отобьёт заявку на
 *     выведенную из эксплуатации карточку (Ф2) — подставленный id обещал бы ход, которого нет;
 *   * карточка вне его области — писать в ИТ-службу: ни наименования, ни места, ни подразделения.
 *     Раскрывается ровно один факт — «такой номер существует», — а его человек и так знает: он сам
 *     его и ввёл.
 *
 * РАСКРЫТИЕ ФАКТА ПРИНЯТО СОЗНАТЕЛЬНО (Р10): альтернатива — принять кандидата-двойника, довести его
 * до проверяющего и кончить тем же ответом, только через день и чужими руками.
 */
export async function assertNoParkDuplicate(
  p: Principal,
  numbers: CandidateNumbers,
): Promise<void> {
  const serial = numbers.serialNumber.trim();
  const inventory = numbers.inventoryNumber.trim();
  const matches = [
    serial ? sameNumberSql(officeEquipment.serialNumber, serial) : undefined,
    inventory ? sameNumberSql(officeEquipment.inventoryNumber, inventory) : undefined,
  ].filter((c): c is SQL => c !== undefined);
  // Схема требует хотя бы один номер, но утверждение проверяется, а не подразумевается: пустой
  // `or(...)` выбрал бы весь парк и превратил рубеж в отказ каждому заявителю.
  if (matches.length === 0) return;

  const found = await db
    .select({
      id: officeEquipment.id,
      name: officeEquipment.name,
      serialNumber: officeEquipment.serialNumber,
      inventoryNumber: officeEquipment.inventoryNumber,
      isActive: officeEquipment.isActive,
      objectId: officeEquipment.objectId,
      ownerDepartmentId: officeEquipment.ownerDepartmentId,
    })
    .from(officeEquipment)
    // Удалённая карточка номер не держит: тем же условием ограничены и уникальные индексы парка,
    // и заводить кандидата на номер снесённой карточки законно.
    .where(and(isNull(officeEquipment.deletedAt), or(...matches)))
    /*
     * ДВЕ — ЭТО ПОТОЛОК, а не осторожная оценка: номера уникальны среди живых карточек, поэтому по
     * каждому из двух совпасть может максимум одна строка. Разными они бывают, когда серийный
     * назван у одной карточки, а инвентарный — у другой (опечатка при заведении парка), и тогда
     * ответ обязан быть определённым, а не «какая строка пришла первой», — его выбирает разбор
     * ниже.
     */
    .limit(2);
  if (found.length === 0) return;

  /*
   * ОБЛАСТЬ СЧИТАЕТСЯ ТЕМ ЖЕ ПРЕДИКАТОМ, ЧТО И СПРАВОЧНИК (`officeEquipmentScopeWhere`), а не
   * сравнением объекта со списком привязок: у роли отдела область парка — это отделы-владельцы и
   * неразмеченная техника, и повторенное здесь «своими руками» правило разошлось бы с ним на первой
   * же правке. Отдельным запросом по найденным идентификаторам, а не коррелированным подзапросом:
   * тот в односоставном запросе drizzle молча теряет корреляцию.
   */
  const scope = officeEquipmentScopeWhere(
    p,
    officeEquipment.objectId,
    officeEquipment.ownerDepartmentId,
  );
  const visible = scope
    ? new Set(
        (
          await db
            .select({ id: officeEquipment.id })
            .from(officeEquipment)
            .where(
              and(
                inArray(
                  officeEquipment.id,
                  found.map((r) => r.id),
                ),
                isNull(officeEquipment.deletedAt),
                scope,
              ),
            )
        ).map((r) => r.id),
      )
    : new Set(found.map((r) => r.id));

  // Порядок выбора — от самого полезного ответа к самому скупому: активная своя даёт человеку
  // готовый ход, неактивная своя — следующий шаг, чужая — только адрес, куда написать.
  const own = found.filter((row) => visible.has(row.id));
  const active = own.find((row) => row.isActive);
  if (active) {
    throw err.conflict(
      `Аппарат уже в справочнике: «${officeEquipmentTitle(active)}». Выберите его в поле`,
      {
        code: OFFICE_EQUIPMENT_CANDIDATE_CONFLICT_CODES.parkDuplicate,
        details: {
          kind: 'parkDuplicate',
          officeEquipmentId: active.id,
          title: officeEquipmentTitle(active),
        },
      },
    );
  }
  if (own.length > 0) {
    throw err.conflict(
      'Аппарат есть в справочнике, но снят с эксплуатации. Попросите оператора вернуть его в работу или выберите другой',
      {
        code: OFFICE_EQUIPMENT_CANDIDATE_CONFLICT_CODES.parkDuplicate,
        details: { kind: 'parkDuplicate', officeEquipmentId: null, title: null },
      },
    );
  }
  throw err.conflict(
    'Аппарат с этим номером уже заведён, но числится за другим подразделением. Напишите в ИТ-службу',
    {
      code: OFFICE_EQUIPMENT_CANDIDATE_CONFLICT_CODES.parkDuplicate,
      details: { kind: 'parkDuplicate', officeEquipmentId: null, title: null },
    },
  );
}

/**
 * РУБЕЖ 2: об этом аппарате уже сообщили, и сообщение ещё ждёт проверки (Р10).
 *
 * Отказ собирается ПОСЛЕ отката транзакции и по номеру, который назвал индекс: искать «какой-нибудь
 * ожидающий кандидат» было бы неверно — совпасть мог любой из двух номеров, и человеку надо знать,
 * какой именно.
 *
 * НОМЕР ЧУЖОЙ ЗАЯВКИ НАЗЫВАЕТСЯ, ТОЛЬКО ЕСЛИ ОНА ВИДИМА СМОТРЯЩЕМУ. Это не вежливость: пара
 * «кандидат + заявка» принадлежит другому человеку и, возможно, другому подразделению, и «СО-14» в
 * отказе рассказало бы о ней тому, кому она не видна. Видимость спрашивается общим предикатом
 * заявок (`serviceRequestVisibilityWhere`) — тем же, которым основание `related` откроет самого
 * кандидата (Р9), и вторым правилом рядом он разошёлся бы с первым.
 */
async function pendingDuplicateConflict(
  p: Principal,
  constraint: string,
  key: string,
): Promise<never> {
  const column =
    constraint === CANDIDATE_SERIAL_PENDING_CONSTRAINT
      ? officeEquipmentCandidates.serialNumber
      : officeEquipmentCandidates.inventoryNumber;
  const [pending] = await db
    .select({ requestId: serviceRequests.id, num: serviceRequests.num })
    .from(officeEquipmentCandidates)
    .leftJoin(
      serviceRequests,
      eq(serviceRequests.equipmentCandidateId, officeEquipmentCandidates.id),
    )
    .where(
      and(eq(officeEquipmentCandidates.status, 'pending'), sql`upper(btrim(${column})) = ${key}`),
    );
  const visible =
    pending?.requestId != null
      ? await db
          .select({ num: serviceRequests.num })
          .from(serviceRequests)
          .where(and(eq(serviceRequests.id, pending.requestId), serviceRequestVisibilityWhere(p)))
      : [];
  const where = visible[0]
    ? ` Он уже приложен к заявке ${formatServiceRequestNumber(visible[0].num)}.`
    : '';
  throw err.conflict(`Этот аппарат уже отправлен на проверку.${where}`, {
    code: OFFICE_EQUIPMENT_CANDIDATE_CONFLICT_CODES.pendingDuplicate,
  });
}

/**
 * Разбор `23505` СНАРУЖИ уже прерванной транзакции (§8, приём и довод — шага 8 закупки).
 *
 * ПОЧЕМУ СНАРУЖИ. К моменту `23505` транзакция прервана, и читать в ней нечего: любой запрос в ней
 * ответит `25P02`. Победившая строка перечитывается новым запросом.
 *
 * ПОЧЕМУ ПО ИМЕНИ, А НЕ ПО КОДУ. `23505` в этой транзакции способны дать и другие ограничения —
 * уникальность номера заявки, пара «заявка + файл», строгий аудит. Перехвати мы код целиком,
 * настоящий дефект базы вернулся бы клиенту УСПЕШНЫМ ПОВТОРОМ, то есть чужой заявкой вместо ошибки.
 *
 * ПОЧЕМУ СНАЧАЛА КЛЮЧ, А НЕ ИМЯ ИНДЕКСА. Одинаковое тело, отправленное дважды, конфликтует
 * ОДНОВРЕМЕННО и по ключу, и по номеру ожидающего кандидата, а PostgreSQL не обещает, какой из
 * индексов сообщит первым (§8). Разбирай мы по имени, честный повтор потерянного ответа получал бы
 * то прежнюю пару, то «аппарат уже отправлен на проверку» — через раз и без всякой закономерности.
 * Поэтому победитель по ключу перечитывается ВСЕГДА и первым, а имя индекса решает лишь судьбу
 * случая «победителя по ключу нет».
 */
export async function asCandidateIntakeRepeat(
  e: unknown,
  p: Principal,
  key: string,
  fingerprint: string,
  numbers: CandidateNumbers,
): Promise<{ requestId: string }> {
  const pg = pgErrorOf(e);
  const known =
    pg?.code === '23505' &&
    (pg.constraint === CANDIDATE_IDEMPOTENCY_CONSTRAINT ||
      pg.constraint === CANDIDATE_SERIAL_PENDING_CONSTRAINT ||
      pg.constraint === CANDIDATE_INVENTORY_PENDING_CONSTRAINT);
  if (!known) throw e;

  const winner = await findIntakeRepeat(p, key, fingerprint);
  if (winner) return { requestId: winner };
  if (pg!.constraint === CANDIDATE_IDEMPOTENCY_CONSTRAINT) idempotencyConflict();
  const number =
    pg!.constraint === CANDIDATE_SERIAL_PENDING_CONSTRAINT
      ? numbers.serialNumber
      : numbers.inventoryNumber;
  return await pendingDuplicateConflict(p, pg!.constraint!, number.trim().toUpperCase());
}
