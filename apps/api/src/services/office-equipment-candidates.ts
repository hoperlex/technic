import { and, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  can,
  // Отказ приёмки словами (Р16, §8) приходит ИЗ КОНТРАКТОВ, а не объявляется здесь второй раз.
  // Тот же текст портал ставит причиной выключенного пункта «Принять» (`disabledReason`), и место
  // объявления обязано быть одно: две копии, совпадающие сегодня, разошлись бы на первой же правке
  // формулировки — и разошлись бы МОЛЧА, потому что ничем друг с другом не связаны. Человек читал
  // бы в меню одни слова, жал бы всё равно (путей к приёмке два) и получал бы от сервера другие,
  // решив, что это две разные поломки. Разбор — при самой константе в
  // `packages/contracts/src/office-equipment-candidates.ts`.
  CANDIDATE_PENDING_ACCEPT_REFUSAL,
  formatServiceRequestNumber,
  officeEquipmentTitle,
  type OfficeEquipmentCandidateDto,
  type OfficeEquipmentCandidateStatus,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departments,
  officeEquipment,
  officeEquipmentCandidates,
  officeEquipmentTypes,
  serviceRequests,
  users,
} from '../db/schema';
import type { Principal } from '../auth/principal';
import { serviceRequestVisibilityWhere } from '../lib/access';
import { err } from '../lib/errors';

/**
 * Чтение кандидата на добавление техники — запрос и сборка DTO (план
 * `docs/office-equipment-candidate-plan.md`, Р9, §8).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ ФАЙЛОМ, А НЕ ВНУТРИ МАРШРУТА. У этого DTO три читателя, и живут они в разных
 * местах: очередь проверки и карточка кандидата (`routes/office-equipment-candidates.ts`), решения
 * проверяющего, которым надо вернуть свежее состояние после условной записи, и встроенный в
 * карточку заявки блок «предмет ещё не проверен» (Р9), который собирает модуль заявок. Оставь мы
 * сборку в обработчике, третий читатель либо переписал бы её у себя — и разошёлся бы на первом же
 * новом поле, — либо получил бы её импортом из файла маршрутов, то есть вместе со всеми стражами и
 * схемами, которые ему не нужны. Приём тот же, что у закупки (`services/office-equipment-purchases`).
 *
 * ВИДИМОСТЬ ЖИВЁТ НЕ ЗДЕСЬ, а в `lib/access.ts` (`officeEquipmentCandidateScopeWhere`): здесь её
 * только применяют. Это тот же порядок, что у заявок, и держится он ровно затем, чтобы «какие
 * строки видно» не оказалось записано в двух местах — правило видимости уже размножалось по
 * читателям однажды, и две копии из пяти вышли неполными.
 */

/** Одинаковый ответ на «нет такого» и «есть, но не ваш» (§8): о чужом сообщении знать не нужно. */
export const CANDIDATE_NOT_FOUND = 'Сообщение о технике не найдено';

/*
 * Псевдонимы обязательны у трёх подписей учёток — автор, правивший и решивший, — это одна таблица
 * в трёх ролях. Заявке псевдоним нужен по другой причине, и она важнее: основание `related` внутри
 * предиката видимости само спрашивает `service_requests` коррелированным `EXISTS`, и одноимённая
 * таблица во внешнем `FROM` читалась бы там как ссылка на внешнюю строку — условие стало бы
 * тавтологией, отдающей всё подряд вместо отобранного. Этот класс ошибки уже стоил порталу молчаливой
 * неправды в счётчиках оргтехники (`office-equipment-sql-correlation.test.ts`).
 */
const authorUser = alias(users, 'candidate_author');
const updatedByUser = alias(users, 'candidate_updated_by');
const decidedByUser = alias(users, 'candidate_decided_by');
const authorDepartment = alias(departments, 'candidate_author_department');
const resultEquipment = alias(officeEquipment, 'candidate_result_equipment');
const linkedRequest = alias(serviceRequests, 'candidate_request');

/**
 * Видима ли смотрящему единственная связанная заявка — ОДНОЙ ВЕЛИЧИНОЙ В ТОМ ЖЕ ЗАПРОСЕ, а не
 * вторым походом в базу по её `id`.
 *
 * Тем же предикатом заявки, что и основание `related` видимости кандидата: разойдись они, карточка
 * показывала бы ссылку на заявку, которую не открыть, — либо, наоборот, прятала бы номер заявки от
 * того, кто её и так читает. Колонки берутся у ПСЕВДОНИМА — ровно ради этого у предиката и есть
 * параметр колонок.
 *
 * `COALESCE(..., false)`: у левого соединения без пары все колонки заявки пусты, и предикат по ним
 * даёт `NULL`, а не «нет». Ветка `undefined` означает «сужать нечем» (администратор, сквозная
 * область набора) — тогда видима любая существующая заявка, и вопрос сводится к тому, нашлась ли
 * пара вообще. Пустой связи по построению не бывает (Р4), но `null` здесь честнее выдуманного
 * `true`: строку без заявки мы увидим как «заявка не видна», а не как ссылку в никуда.
 */
function requestVisibleExpr(p: Principal): SQL<boolean> {
  const visible = serviceRequestVisibilityWhere(p, {
    id: linkedRequest.id,
    objectId: linkedRequest.equipmentObjectId,
    customerDepartmentId: linkedRequest.customerDepartmentId,
    equipmentDepartmentId: linkedRequest.equipmentDepartmentId,
    serviceCounterpartyId: linkedRequest.serviceCounterpartyId,
  });
  return visible === undefined
    ? sql<boolean>`${linkedRequest.id} IS NOT NULL`
    : sql<boolean>`COALESCE(${visible}, false)`;
}

/** Строка запроса: плоская, потому что DTO собирается из неё одной функцией ниже. */
interface CandidateRow {
  id: string;
  status: OfficeEquipmentCandidateStatus;
  contentVersion: number;
  declaredModel: string;
  serialNumber: string;
  inventoryNumber: string;
  location: string;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
  decidedAt: Date | null;
  decisionReason: string;
  typeId: string;
  typeName: string;
  typeIsActive: boolean;
  objectId: string;
  objectCode: string;
  objectName: string;
  authorId: string;
  authorName: string;
  /** `null` — у автора нет подразделений вовсе (администратор): законное состояние, а не потеря. */
  authorDepartmentName: string | null;
  updatedByName: string | null;
  decidedByName: string | null;
  resultId: string | null;
  resultName: string | null;
  resultSerialNumber: string | null;
  resultInventoryNumber: string | null;
  requestId: string | null;
  requestNum: number | null;
  requestStatus: ServiceRequestStatus | null;
  requestVisible: boolean;
}

/**
 * Запрос кандидата со всеми подписями. Соединений семь, и каждое отвечает на свой вопрос карточки;
 * второй запрос «дочитать имена» вместо них дал бы N+1 на очереди из полусотни строк.
 *
 * Тип и площадка — `innerJoin`: обе колонки `NOT NULL` со ссылкой `restrict`, и строка без них
 * невозможна; `leftJoin` здесь обещал бы состояние, которого база не допускает, и прятал бы
 * настоящую поломку данных за пустым полем вместо отказа.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Кто выполняет чтение: обычное соединение — либо транзакция. Второго читателя здесь пока нет, и
 * заведён он под решения проверяющего (Э4): они перечитывают свежее состояние сразу после условной
 * записи, внутри своей транзакции, и без этого параметра им пришлось бы либо ждать её конца, либо
 * завести вторую сборку того же DTO.
 */
type Reader = Tx | typeof db;

function candidateQuery(runner: Reader, p: Principal) {
  return runner
    .select({
      id: officeEquipmentCandidates.id,
      status: officeEquipmentCandidates.status,
      contentVersion: officeEquipmentCandidates.contentVersion,
      declaredModel: officeEquipmentCandidates.declaredModel,
      serialNumber: officeEquipmentCandidates.serialNumber,
      inventoryNumber: officeEquipmentCandidates.inventoryNumber,
      location: officeEquipmentCandidates.location,
      comment: officeEquipmentCandidates.comment,
      createdAt: officeEquipmentCandidates.createdAt,
      updatedAt: officeEquipmentCandidates.updatedAt,
      decidedAt: officeEquipmentCandidates.decidedAt,
      decisionReason: officeEquipmentCandidates.decisionReason,
      typeId: officeEquipmentTypes.id,
      typeName: officeEquipmentTypes.name,
      typeIsActive: officeEquipmentTypes.isActive,
      objectId: constructionObjects.id,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      authorId: authorUser.id,
      authorName: authorUser.fullName,
      authorDepartmentName: authorDepartment.name,
      updatedByName: updatedByUser.fullName,
      decidedByName: decidedByUser.fullName,
      resultId: resultEquipment.id,
      resultName: resultEquipment.name,
      resultSerialNumber: resultEquipment.serialNumber,
      resultInventoryNumber: resultEquipment.inventoryNumber,
      requestId: linkedRequest.id,
      requestNum: linkedRequest.num,
      requestStatus: linkedRequest.status,
      requestVisible: requestVisibleExpr(p),
    })
    .from(officeEquipmentCandidates)
    .innerJoin(
      officeEquipmentTypes,
      eq(officeEquipmentTypes.id, officeEquipmentCandidates.equipmentTypeId),
    )
    .innerJoin(constructionObjects, eq(constructionObjects.id, officeEquipmentCandidates.objectId))
    .innerJoin(authorUser, eq(authorUser.id, officeEquipmentCandidates.createdBy))
    .leftJoin(
      authorDepartment,
      eq(authorDepartment.id, officeEquipmentCandidates.requesterDepartmentId),
    )
    .leftJoin(updatedByUser, eq(updatedByUser.id, officeEquipmentCandidates.updatedBy))
    .leftJoin(decidedByUser, eq(decidedByUser.id, officeEquipmentCandidates.decidedBy))
    .leftJoin(resultEquipment, eq(resultEquipment.id, officeEquipmentCandidates.resultEquipmentId))
    .leftJoin(linkedRequest, eq(linkedRequest.equipmentCandidateId, officeEquipmentCandidates.id));
}

/**
 * Строка запроса — в DTO.
 *
 * БЛОК АВТОРА ОТДАЁТСЯ ТОЛЬКО ПРОВЕРЯЮЩЕМУ (Р9), и решается это правом, а не тем, каким основанием
 * смотрящий сюда дошёл. Остальным блока нет ВОВСЕ, а не с пустыми полями: контакт заявителя уже
 * виден в самой заявке, и второй раз перечислять ФИО рядом с предметом значило бы расширять
 * видимость персональных данных ради удобства вёрстки. Отсутствие поля читается как «этот срез
 * ответа такого не содержит», а не «автор неизвестен» — тот же приём, что у среза расходников в
 * карточке парка.
 *
 * ССЫЛКА НА ЗАЯВКУ ГАСНЕТ, А НЕ ПРЯЧЕТ КАРТОЧКУ ЦЕЛИКОМ: `null` означает «заявка есть, но
 * смотрящему не видна» (кандидатов без заявки не бывает по построению, Р4). Так бывает у
 * централизованного проверяющего, которому очередь открыта правом, а заявки чужого отдела — нет.
 */
function toCandidateDto(row: CandidateRow, withAuthor: boolean): OfficeEquipmentCandidateDto {
  return {
    id: row.id,
    status: row.status,
    contentVersion: row.contentVersion,
    equipmentType: { id: row.typeId, name: row.typeName, isActive: row.typeIsActive },
    declaredModel: row.declaredModel,
    serialNumber: row.serialNumber,
    inventoryNumber: row.inventoryNumber,
    object: { id: row.objectId, code: row.objectCode, name: row.objectName },
    location: row.location,
    comment: row.comment,
    ...(withAuthor
      ? {
          author: {
            id: row.authorId,
            name: row.authorName,
            departmentName: row.authorDepartmentName,
          },
        }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedByName: row.updatedByName,
    updatedAt: row.updatedAt.toISOString(),
    decidedByName: row.decidedByName,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionReason: row.decisionReason,
    resultEquipment:
      row.resultId === null
        ? null
        : {
            id: row.resultId,
            title: officeEquipmentTitle({
              name: row.resultName ?? '',
              serialNumber: row.resultSerialNumber ?? '',
              inventoryNumber: row.resultInventoryNumber ?? '',
            }),
          },
    request:
      row.requestId !== null && row.requestVisible && row.requestNum !== null
        ? {
            id: row.requestId,
            num: row.requestNum,
            displayNumber: formatServiceRequestNumber(row.requestNum),
            status: row.requestStatus!,
          }
        : null,
  };
}

/**
 * Видит ли смотрящий блок автора. Отдельной функцией, потому что спрашивают её и здесь, и в
 * решениях проверяющего: разойдись эти два ответа, одно и то же сообщение показывало бы автора в
 * очереди и прятало его после нажатия кнопки.
 */
function showsAuthor(p: Principal): boolean {
  return can(p, 'officeEquipment.review');
}

/** Страница очереди: тем же запросом и той же сборкой, что и карточка. */
export async function selectCandidates(
  p: Principal,
  where: SQL | undefined,
  orderBy: SQL,
  limit: number,
  offset: number,
): Promise<OfficeEquipmentCandidateDto[]> {
  const rows = await candidateQuery(db, p)
    .where(where)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);
  const withAuthor = showsAuthor(p);
  return rows.map((row) => toCandidateDto(row, withAuthor));
}

/**
 * Кандидат по идентификатору — СРАЗУ С ПРЕДИКАТОМ ВИДИМОСТИ в условии, а не «прочитать и потом
 * проверить». Разница не стилистическая: проверка после чтения живёт отдельной строкой, и забыть её
 * можно молча, а условие в `WHERE` забыть нельзя — без него запрос не собирается вовсе. Вне
 * видимости ответ 404, а не 403 (§8): о существовании чужого сообщения знать не нужно, а 403 сам по
 * себе сообщал бы, что такой кандидат есть.
 *
 * `scope` параметром, потому что оснований у двух дверей разное число: карточка спрашивает полный
 * предикат Р9, очередь и правка — одно основание `review`. Ответственность за выбор лежит на
 * маршруте, где рядом стоит и страж права: пара «право + основание» читается в одном месте.
 */
export async function loadCandidateDto(
  p: Principal,
  id: string,
  scope: SQL | undefined,
  runner: Reader = db,
): Promise<OfficeEquipmentCandidateDto | null> {
  const [row] = await candidateQuery(runner, p).where(
    and(eq(officeEquipmentCandidates.id, id), scope),
  );
  return row ? toCandidateDto(row, showsAuthor(p)) : null;
}

/**
 * Тот же кандидат, но отказом вместо пустоты: у всех трёх дверей ответ на «не найден» один, и
 * повторять его текст по месту значило бы завести три написания одного и того же.
 */
export async function requireCandidateDto(
  p: Principal,
  id: string,
  scope: SQL | undefined,
  runner: Reader = db,
): Promise<OfficeEquipmentCandidateDto> {
  const dto = await loadCandidateDto(p, id, scope, runner);
  if (!dto) throw err.notFound(CANDIDATE_NOT_FOUND);
  return dto;
}

/**
 * Строка кандидата под `FOR UPDATE` — то, чем начинаются и решение проверяющего, и замок приёмки
 * (Р11, Р13, Р16).
 *
 * ВТОРЫМ ШАГОМ ПОСЛЕ БЛОКИРОВКИ ЗАЯВКИ, И ПОРЯДОК ЭТОТ ОБЯЗАТЕЛЕН. Обе транзакции — решение и
 * `PATCH /service-requests/:id/accept` — встречаются на одной и той же паре строк, и берут они их
 * в одном порядке «заявка → кандидат». Возьми одна из них кандидата первым, две одновременные
 * попытки заперли бы друг друга насмерть: приёмка держала бы заявку и ждала кандидата, решение —
 * наоборот. Дедлок Postgres разрубает сам, но ценой `40P01` пятисоткой одному из двух людей, и
 * ловится он только под нагрузкой — то есть в проде. Поэтому порядок записан здесь словами, а
 * проверяется тестом гонки решения с приёмкой.
 *
 * Только две колонки: у обоих читателей вопрос к строке один — «решено ли уже и та ли это
 * редакция». Реквизиты после блокировки перечитывает `loadCandidateDto` тем же соединением.
 *
 * `scope` необязателен намеренно. Решение спрашивает область очереди проверяющего — иначе строку
 * можно было бы решить из чужой очереди; замку приёмки область не нужна вовсе и была бы прямой
 * ошибкой: приёмку делает не проверяющий, и сужь мы кандидата его областью, замок молча пропускал
 * бы ровно те заявки, ради которых заведён.
 */
export async function lockCandidateRow(
  tx: Tx,
  id: string,
  scope?: SQL | undefined,
): Promise<{ status: OfficeEquipmentCandidateStatus; contentVersion: number } | null> {
  const [row] = await tx
    .select({
      status: officeEquipmentCandidates.status,
      contentVersion: officeEquipmentCandidates.contentVersion,
    })
    .from(officeEquipmentCandidates)
    .where(and(eq(officeEquipmentCandidates.id, id), scope))
    .for('update');
  return row ?? null;
}

/**
 * ЗАМОК ПРИЁМКИ: пока сообщение о технике ждёт проверки, заявку не принимают (`done → accepted`,
 * Р16).
 *
 * ПОЧЕМУ ЗАПРЕТ ИМЕННО НА ПРИЁМКЕ, А НЕ НА ВХОДЕ В РАБОТУ. Ремонт нельзя тормозить проверкой
 * справочника: принтер сломан сейчас, и заявка обязана ехать, назначаться и закрываться обычным
 * ходом. Но принимать работу, пока проверка не дала ни карточку, ни отказ, нельзя: исход
 * переписывает снимок предмета и гарантийный контекст (Р6) — уже после того, как работу приняли.
 * Замок поздний, узкий и дешёвый; ранний стоил бы работы людям, к справочнику отношения не имеющим.
 *
 * ПРИ ЛЮБОМ РЕШЕНИИ ЗАМОК СНЯТ, включая отказ, и это тоже решение плана: держи мы его у
 * `rejected`, заявка навсегда застряла бы в «Решена» — принять нельзя, а отменить её за оператора
 * решение по справочнику не вправе (Р16). Отклонённый кандидат остаётся сохранённым
 * предметом-свидетельством, и обычные ходы заявке доступны все.
 *
 * 422, а не 409: 409 по умолчанию несёт код `version_conflict`, которым портал говорит «обновите и
 * повторите», — а повторять здесь нечего, ждать надо чужого решения. Поле `status` в ответе — то
 * же, чем отвечают остальные отказы перехода этого модуля.
 */
export async function assertCandidateDecided(tx: Tx, candidateId: string | null): Promise<void> {
  if (!candidateId) return;
  const row = await lockCandidateRow(tx, candidateId);
  // Строки нет вовсе — состояние невозможное (ссылка `restrict`), и запирать заявку из-за него
  // было бы отказом без причины: замок держится существующим `pending`, а не отсутствием ответа.
  if (!row || row.status !== 'pending') return;
  throw err.unprocessable(
    `${CANDIDATE_PENDING_ACCEPT_REFUSAL}: сообщение об аппарате ещё на проверке`,
    { status: 'Решение по технике не принято' },
  );
}
