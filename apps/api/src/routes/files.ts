import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { and, eq, exists, inArray, isNotNull, isNull, not, or, type SQL, sql } from 'drizzle-orm';
import {
  actsForCounterparty,
  can,
  createUploadSessionSchema,
  fileDownloadQuerySchema,
  type FileDto,
  isInlineViewable,
  type ServiceRequestAudience,
  visibleServiceFileKinds,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import {
  autoPartReceiptFiles,
  driverDailyReports,
  files,
  type FileRow,
  mechRequestFiles,
  mechRequests,
  requestFiles,
  serviceRequestExecutors,
  serviceRequestFiles,
  serviceRequests,
  vehicleMaintenanceFiles,
  vehicleReadingFiles,
  vehicleReadings,
  vehicleRequestAssignments,
  vehicleRequestFiles,
  vehicleRequests,
  vehicles,
  wasteRequests,
  wasteTicketFieldEvents,
  waybillFiles,
  waybills,
} from '../db/schema';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { requirePrincipal } from '../auth/plugin';
import {
  lessorVisibilityWhere,
  operatorVisibilityWhere,
  serviceRequestVisibilityWhere,
  placeObjectVisibilityWhere,
  vehicleRequestVisibilityWhere,
  waybillVisibilityWhere,
} from '../lib/access';
import {
  cancelScheduledObjectDeletion,
  isFileLinked,
  scheduleObjectDeletion,
} from '../services/request-files';
import type { Principal } from '../auth/principal';
import { buildObjectKey, deleteObject, headObject, presignGet, presignPut, s3 } from '../lib/s3';
import { enqueueJob, JOB_DELETE_S3_OBJECT } from '../lib/jobs';
import { logger } from '../logger';

const idParams = z.object({ id: z.string().uuid() });
const S3_DELETE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Причина карантина и причина его снятия — обязательны обе (план
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р6, п. 4).
 *
 * Карантин запирает содержимое от всех, включая автора и «Ведение», а основание денежного решения
 * снять нельзя никогда: через месяц на вопрос «почему акт не открывается» ответить может только эта
 * строка — в самой записи файла остаётся лишь отметка времени. Необязательная причина превратила бы
 * журнал в «кто-то что-то спрятал».
 *
 * Схема лежит здесь, а не в `packages/contracts/src/files.ts`, только потому, что контракты файлов
 * в эту волну не правятся; место ей там, рядом с остальными схемами модуля (см. поле `open` отчёта).
 */
const quarantineBodySchema = z.object({ reason: z.string().trim().min(1).max(1000) });

/**
 * SHA-256 содержимого объекта — доказательство того, что по праву аудита смотрят ТОТ САМЫЙ файл, а
 * не подменённый за это время объект хранилища.
 *
 * Потоком, а не целиком в память: предел загрузки измеряется десятками мегабайт, а карантин ставят
 * по инциденту — в момент, когда на сервере и без того происходит разбор.
 *
 * **Неудача возвращает `null`, а не исключение.** Хеш считается ПОСЛЕ закрытия доступа, и падение
 * хранилища не должно превращать поставленный карантин в ошибку запроса: недосчитанный хеш остаётся
 * пустым и уходит в аудит как «посчитать не удалось» (комментарий колонки `content_hash` в
 * `db/schema.ts`).
 */
async function contentHashOf(objectKey: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: objectKey }));
    const body = res.Body as AsyncIterable<Uint8Array> | undefined;
    if (!body) return null;
    const hash = createHash('sha256');
    for await (const chunk of body) hash.update(chunk);
    return hash.digest('hex');
  } catch (e) {
    logger.error({ err: e, objectKey }, 'Не удалось посчитать хеш карантинного файла');
    return null;
  }
}

/**
 * Имя карантинного файла ЭТА функция не прячет намеренно (план освобождения от подписи, Р6, п. 4).
 *
 * Запрет живёт в обработчиках: до `toFileDto` карантинный файл доходит только у держателя права
 * разбора — остальным обе отдающие имя ручки отвечают `404`. Замажь имя здесь, и оно исчезло бы
 * ровно у того единственного, кому разбор инцидента поручен, а правило о доступе раздвоилось бы на
 * два места. Сборщики DTO соседних модулей (список файлов карточки) прячут имя у себя — у них
 * карантинная строка остаётся в ответе признаком, и прятать там нужно не ответ, а поле.
 */
export function toFileDto(f: FileRow): FileDto {
  return {
    id: f.id,
    filename: f.filename,
    contentType: f.contentType,
    size: f.size,
    status: f.status,
    createdAt: f.createdAt.toISOString(),
  };
}

/** Помечает файл удалённым и планирует физическое удаление из S3 через 30 дней. */
export async function softDeleteFile(fileId: string, objectKey: string): Promise<void> {
  await db
    .update(files)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(eq(files.id, fileId));
  await enqueueJob(
    JOB_DELETE_S3_OBJECT,
    { objectKey },
    { runAt: new Date(Date.now() + S3_DELETE_DELAY_MS) },
  );
}

/**
 * Где найден файл: связи проверяются только по тем модулям, которые роли вообще доступны.
 *
 * Признак на модуль, а не общий «файл виден»: право читать чужой модуль ничего не открывает, и
 * оператор вывоза не должен получать вложение заявки на технику только потому, что связь нашлась.
 * Каждый новый модуль с вложениями заводит здесь своё поле — молча пройти по чужой ветке нельзя.
 */
export interface FileLinkage {
  /** Файл связан с видимой пользователю заявкой вывоза (вложение заявки или талон машины). */
  visibleWaste: boolean;
  /** Файл связан с видимой пользователю заявкой на технику. */
  visibleVehicle: boolean;
  /** Файл связан с видимой пользователю заявкой на обслуживание оргтехники (ADR 0084). */
  visibleService: boolean;
  /**
   * Файл подшит к путевому листу (миграция 0087). Своей области у журнала листов нет — его
   * закрывает одно право `waybills.read`, — поэтому «видим» здесь означает ровно «связь нашлась»,
   * а не «лист попал в область». Аннулированный лист вложения не теряет: испорченный бланк
   * подшивают к журналу вместе с тем, что к нему пришло.
   */
  visibleWaybill: boolean;
  /**
   * Файл связан с видимой пользователю заявкой на аренду малой механизации (план
   * `docs/mechanization-module-plan.md`, Р14).
   *
   * Область у модуля одна и считается одной колонкой — площадкой эксплуатации (Р10): объектная ось
   * сравнивает её со своими объектами, отдельская — с площадками своих отделов. Своей оси по
   * контрагенту здесь нет и быть не должно: арендодатель механизации в портал не входит вовсе
   * (Р6), поэтому предикат берётся ровно тот же, каким модуль отбирает список.
   */
  visibleMech: boolean;
  /**
   * Файл — скан акта техобслуживания (миграция 0147). Условие одно — связь, по той же причине, что
   * у путевых листов: журнал ТО не сужается ни объектом, ни контрагентом — парк у портала один, и
   * своей оси области у службы механика не заведено (`ACCESS_PROFILES`).
   *
   * Ветка обязана быть отдельной, а не частью показаний: право у ТО своё (Р14), и механик, которому
   * `vehicleReadings.read` не дают намеренно, без неё не открыл бы собственноручно подшитый акт.
   */
  visibleMaintenance: boolean;
  /**
   * Файл — скан чека на автозапчасти (миграция 0243, план `docs/auto-part-receipts-plan.md`, Р20).
   * Условие одно — связь, по той же причине, что у сканов акта ТО и путевых листов: своей оси
   * области у службы механика в портале нет (`ACCESS_PROFILES`), парк один, и чеки не сужаются ни
   * объектом, ни контрагентом. Обратная сторона названа прямо: держатель `garage.read` открывает
   * скан любого чека — ровно та же граница, что у журнала ТО.
   *
   * Без этой ветки скан чека не открылся бы НИКОМУ, включая подшившего его механика: собственный
   * `uploadedBy` работает только у файла, не привязанного никуда, а привязанный сразу становится
   * «чужим».
   */
  visibleReceipt: boolean;
  /**
   * Файл привязан к показанию — и у принципала есть право читать показания парка (Р34). Своей
   * области у показаний нет по той же причине, что у журнала листов: список показаний не сужается
   * ни объектом, ни контрагентом, и придумывать фотографии область, которой нет у самих чисел,
   * значило бы прятать файл, который портал в строке показывает.
   */
  visibleReading: boolean;
  /**
   * Файл привязан к показанию, отчёт которого принадлежит самому принципалу (Р34).
   *
   * Отдельный признак, а не частный случай предыдущего: у водителя нет права `vehicleReadings.read`
   * — оно про весь парк, — поэтому без этой ветки он не открыл бы собственную фотографию. Считается
   * сравнением `person_id` отчёта с `personId` принципала (четвёртая ось области, Р5): доступ по
   * одному лишь `driverCabinet.read` отдавал бы водителю чужие снимки по угаданному UUID.
   */
  ownDriverReading: boolean;
  /** Файл вообще привязан хоть к чему-нибудь — неважно, видно это пользователю или нет. */
  linkedAnywhere: boolean;
}

/**
 * Решение о доступе к файлу по правам и найденным связям (ADR 0021).
 *
 * Авторство даёт доступ только к ещё не привязанному файлу: так работает форма — файл грузится
 * до сохранения заявки и до этого момента виден лишь тому, кто его выбрал. Как только файл
 * попал в заявку, он живёт по её правилам: иначе загрузивший сохранял бы доступ и после смены
 * роли, объекта или контрагента, а сама заявка ему уже не видна.
 *
 * Отсюда же требование к `linkedAnywhere`: последняя строка держится на полноте перечисления
 * таблиц привязки, которое теперь живёт в функции БД `file_is_linked(uuid)` (миграция 0133) и
 * спрашивается через `isFileLinked`. Модуль, о котором та функция не знает, попадает сюда как
 * «файл ничей» — и ветка авторства отдаёт документ бессрочно.
 *
 * **Сквозного аудита талонов (ADR 0137) здесь нет намеренно.** Он не «ещё один модуль с
 * вложениями», а второй вход в тот же вывоз, и решается он не так, как всё перечисленное выше: эта
 * функция складывает признаки в одно «да», после чего сказать, какой именно ветвью открыт файл,
 * уже нельзя. Аудиту это нужно — его открытие пишется в журнал просмотров (§4.2), а обычная работа
 * держателя со своей площадкой не пишется. Признак в `FileLinkage` стёр бы разницу между ними в
 * первой же строке, поэтому ветка живёт в `canAccessFile`, где вход ещё различим.
 */
export function decideFileAccess(
  p: Principal,
  uploadedBy: string | null,
  linkage: FileLinkage,
): boolean {
  if (linkage.visibleWaste && can(p, 'wasteRequests.read')) return true;
  if (linkage.visibleVehicle && can(p, 'vehicleRequests.read')) return true;
  if (linkage.visibleService && can(p, 'serviceRequests.read')) return true;
  if (linkage.visibleWaybill && can(p, 'waybills.read')) return true;
  if (linkage.visibleMech && can(p, 'mechRequests.read')) return true;
  if (linkage.visibleMaintenance && can(p, 'vehicleMaintenance.read')) return true;
  if (linkage.visibleReceipt && can(p, 'garage.read')) return true;
  if (linkage.visibleReading && can(p, 'vehicleReadings.read')) return true;
  if (linkage.ownDriverReading && can(p, 'driverCabinet.read')) return true;
  return !linkage.linkedAnywhere && !!uploadedBy && uploadedBy === p.id;
}

/**
 * Талон ли это — единственный вопрос, на который отвечает ветка сквозного аудита распознавания
 * (ADR 0137, решение 8; план аудита §4.2). Возвращает заявку, в которой талон лежит (её может уже
 * не быть), либо `null`, если файл талоном не является.
 *
 * **Почему `kind = 'ticket'`, а не «файл, связанный с заявкой вывоза».** Право аудита — про
 * машинное чтение бумаги, и открывать им всё подшитое к заявке значило бы отдать держателю заодно
 * договоры, письма и фотографии площадок, к распознаванию отношения не имеющие. Разделяет одно и
 * другое ровно эта колонка — та же, по которой отличает талон от вложения весь модуль разбора.
 *
 * **Почему два источника, а не один.** Талон лежит в `request_files`, пока цела заявка; наблюдение
 * (`waste_ticket_field_events.file_id`) переживает и талон, и заявку — ссылки на них обнуляются, а
 * `file_id` остаётся. Лента аудита показывает наблюдения за весь период, и лупа рядом со строкой
 * обязана открываться, пока цел сам файл: разбор ошибки без картинки бессмыслен, а талон снятый
 * или откатанный для метрики ценнее прочих — его и трогали потому, что с чтением что-то было не
 * так. «Скан недоступен» остаётся ответом только на исчезнувший или помеченный удалённым файл.
 *
 * **Заявка не проверяется ни на удалённость, ни на область** — и это не пропуск: обе проверки
 * стоят выше, в обычной ветке вывоза, а здесь они закрыли бы ровно те талоны, ради которых ветка и
 * заведена. Сквозным аудит выбран заказчиком (§4.1), и цена решения названа там же.
 */
async function wasteTicketScan(fileId: string): Promise<{ requestId: string | null } | null> {
  const [attached] = await db
    .select({ requestId: requestFiles.requestId })
    .from(requestFiles)
    .where(and(eq(requestFiles.fileId, fileId), eq(requestFiles.kind, 'ticket')))
    .limit(1);
  if (attached) return { requestId: attached.requestId };
  const [observed] = await db
    .select({ requestId: wasteTicketFieldEvents.requestId })
    .from(wasteTicketFieldEvents)
    .where(eq(wasteTicketFieldEvents.fileId, fileId))
    .limit(1);
  return observed ? { requestId: observed.requestId } : null;
}

/**
 * Каким входом открыт файл — и открыт ли вообще.
 *
 * Не `boolean`, потому что вход решает не только «отдавать ли», но и «писать ли просмотр»: сквозной
 * аудит талонов виден в журнале, обычная работа — нет (ADR 0137, §4.2). Разбор входа именно здесь,
 * а не догадкой в обработчике: восстанавливать причину доступа второй проверкой значило бы завести
 * второе мнение о правилах — то самое, которое однажды разойдётся с первым и начнёт писать в журнал
 * не те строки (или не писать те).
 */
type FileAccess =
  | { via: 'denied' }
  | { via: 'linkedRecord' }
  | { via: 'ticketAudit'; requestId: string | null }
  /** Карантинный файл, открытый правом разбора инцидента: такой доступ всегда пишется в журнал. */
  | { via: 'quarantineAudit' };

/**
 * «Открывает ли ЭТА заявка субъекту деньги» — `serviceRequestAudienceOf` (ADR 0160, Р1),
 * записанное предикатом SQL над строкой `service_requests`.
 *
 * Правило не переписывается, а раскладывается по тем же двум ветвям, из которых оно состоит в
 * контрактах: право `serviceRequests.finance` (ответ одинаков для всех строк — считается здесь же,
 * до запроса) либо `isServiceExecutor` — оператор назначенного контрагента ЛИБО поимённая строка
 * `service_request_executors` в паре с `serviceRequests.execute`. Разойдись эти две записи, файл
 * оказался бы виден в карточке и не скачивался бы (или наоборот), а расхождение было бы молчаливым.
 *
 * Три ответа, а не один `SQL`: «всегда» и «никогда» известны до запроса, и подставленные в него
 * `true`/`false` только мешали бы читать условие. `never` — не «прав нет вовсе», а «исполнителем
 * этой заявки субъект не бывает ни при каком её содержимом».
 */
function serviceFinanceAudienceWhere(p: Principal): SQL | 'always' | 'never' {
  if (can(p, 'serviceRequests.finance')) return 'always';
  const parts: SQL[] = [];
  // Две половины, как в `executorAssignment`: тип контрагента у учётки и совпадение с исполнителем
  // заявки. Без первой сервисной стороной стал бы любой контрагент с совпавшим идентификатором,
  // без второй — сервисная сторона по чужой заявке.
  //
  // `IS NOT NULL` рядом с равенством — не украшение, а трёхзначная логика: у нераспределённой
  // заявки колонка пуста, `NULL = :id` даёт `UNKNOWN`, и отрицание этой ветви ниже осталось бы
  // `UNKNOWN` — то есть строка не прошла бы НИ ПО ОДНОЙ аудитории и вложение исчезло бы вовсе.
  // Контракты пишут ту же половину теми же словами (`row.serviceCounterpartyId !== null && …`).
  if (actsForCounterparty(p, 'service') && p.counterpartyId) {
    parts.push(
      and(
        isNotNull(serviceRequests.serviceCounterpartyId),
        eq(serviceRequests.serviceCounterpartyId, p.counterpartyId),
      )!,
    );
  }
  // Поимённая строка спрашивается только у того, кто вообще может быть назначен: без
  // `serviceRequests.execute` ответ `isServiceExecutor` всё равно «не исполнитель».
  if (can(p, 'serviceRequests.execute')) {
    parts.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(serviceRequestExecutors)
          .where(
            and(
              eq(serviceRequestExecutors.requestId, serviceRequests.id),
              eq(serviceRequestExecutors.userId, p.id),
            ),
          ),
      ),
    );
  }
  if (parts.length === 0) return 'never';
  return parts.length === 1 ? parts[0]! : or(...parts)!;
}

/**
 * Условие по виду документа для связи «файл ↔ заявка на обслуживание» (ADR 0160, Р7/Р8).
 *
 * Перечень видов не пишется здесь ни одной строкой: его отдаёт `visibleServiceFileKinds` — та же
 * функция, которой режется список файлов карточки. Двух перечней быть не может, расхождение
 * означало бы файл, невидимый в карточке и открывающийся по ссылке.
 *
 * Обе аудитории — явными слагаемыми, включая отрицание: «видно заявителю ИЛИ (я исполнитель И
 * видно исполнителю)» было бы короче, но верно лишь пока перечень заявителя вложен в перечень
 * исполнителя. Это свойство сегодняшней матрицы, а не правило: вид, видимый заявителю и закрытый
 * для денег, короткая запись отдала бы держателю `finance` молча. Здесь же каждая строка
 * получает перечень **своей** аудитории — ровно как её считает `serviceRequestAudienceOf`.
 *
 * Корреляция стоит в `WHERE` запроса с `innerJoin`, а не в списке столбцов односоставной выборки,
 * — там подмена квалификации колонок drizzle не достаёт (`office-equipment-sql-correlation.test.ts`).
 */
function serviceFileKindWhere(p: Principal): SQL {
  const kindsOf = (audience: ServiceRequestAudience): SQL =>
    inArray(serviceRequestFiles.kind, [...visibleServiceFileKinds(audience)]);
  const finance = serviceFinanceAudienceWhere(p);
  if (finance === 'always') return kindsOf('finance');
  if (finance === 'never') return kindsOf('requester');
  return or(and(finance, kindsOf('finance')), and(not(finance), kindsOf('requester')))!;
}

async function canAccessFile(
  p: Principal,
  fileId: string,
  uploadedBy: string | null,
  quarantinedAt: Date | null,
): Promise<FileAccess> {
  /*
   * КАРАНТИН ОТБИВАЕТ ДОСТУП ПЕРВЫМ — раньше вывоза, техники, оргтехники, путевых листов, парка и
   * раньше ветки автора файла (план `docs/office-equipment-on-site-and-invoice-estimate-plan.md`,
   * Р6, п. 4).
   *
   * Порядок здесь — и есть весь карантин. Ставят его по инциденту: в карточку попали чужие
   * персональные данные или секретный документ, а снять файл нельзя НИКОГДА — основание денежного
   * решения не снимается ни автором, ни `files.manageAny`, ни после `reopen` (замки 1–2 того же
   * Р6). Стой эта проверка после ветвей видимости, «скрытый» документ продолжал бы скачиваться по
   * прямой ссылке всем, кому видна заявка, — то есть карантин был бы меткой в карточке, а
   * ошибочно загруженные персональные данные — неустранимым инцидентом.
   *
   * Ветка автора — не исключение, а главный случай: чаще всего именно он и загрузил не тот файл.
   * Единственный вход — право разбора инцидента, и он пишется в журнал (см. обработчик ссылки):
   * сквозное право без следа само стало бы дырой в областях всех модулей разом.
   *
   * Спрашивается здесь, а не в обработчике, по той же причине, по которой здесь живёт ветка аудита
   * талонов: второе мнение о правилах доступа однажды разойдётся с первым — и разойдётся молча.
   */
  if (quarantinedAt) {
    return can(p, 'files.quarantineAudit') ? { via: 'quarantineAudit' } : { via: 'denied' };
  }

  // Связи ищем только по доступным ролям модулям: иначе учётка без роли (и любая новая роль)
  // прошла бы по заявке вывоза — ограничения видимости на неё не действуют, они про штаб и
  // оператора.
  const canReadWaste = can(p, 'wasteRequests.read');
  const canReadVehicle = can(p, 'vehicleRequests.read');
  const canReadService = can(p, 'serviceRequests.read');
  const canReadWaybills = can(p, 'waybills.read');

  let visibleWaste = false;
  if (canReadWaste) {
    // Доступ через связанную не удалённую заявку вывоза, видимую пользователю. Талоны с ADR 0024
    // лежат там же (request_files, kind='ticket'), поэтому отдельной ветки для них нет.
    const waste = await db
      .select({ id: wasteRequests.id })
      .from(requestFiles)
      .innerJoin(wasteRequests, eq(requestFiles.requestId, wasteRequests.id))
      .where(
        and(
          eq(requestFiles.fileId, fileId),
          isNull(wasteRequests.deletedAt),
          placeObjectVisibilityWhere(p, wasteRequests.objectId),
          operatorVisibilityWhere(p, wasteRequests.operatorCounterpartyId),
        ),
      )
      .limit(1);
    visibleWaste = waste.length > 0;
  }

  let visibleVehicle = false;
  if (!visibleWaste && canReadVehicle) {
    const vehicle = await db
      .select({ id: vehicleRequests.id })
      .from(vehicleRequestFiles)
      .innerJoin(vehicleRequests, eq(vehicleRequestFiles.vehicleRequestId, vehicleRequests.id))
      // Назначенная техника нужна не карточке файла, а области видимости: арендодателю видны
      // заявки, на которые вышли его машины (ADR 0038), — и вложения у них те же.
      .leftJoin(
        vehicleRequestAssignments,
        eq(vehicleRequests.id, vehicleRequestAssignments.requestId),
      )
      .leftJoin(vehicles, eq(vehicleRequestAssignments.vehicleId, vehicles.id))
      .where(
        and(
          eq(vehicleRequestFiles.fileId, fileId),
          isNull(vehicleRequests.deletedAt),
          vehicleRequestVisibilityWhere(p, vehicleRequests.objectId, vehicleRequests.departmentId),
          lessorVisibilityWhere(p, vehicles.lessorId),
        ),
      )
      .limit(1);
    visibleVehicle = vehicle.length > 0;
  }

  let visibleService = false;
  if (!visibleWaste && !visibleVehicle && canReadService) {
    // Документы заявки на обслуживание оргтехники (ADR 0084, миграция 0105). Область — не «та же,
    // что в списке заявок», а БУКВАЛЬНО ТА ЖЕ: один вызов `serviceRequestVisibilityWhere`, которым
    // отбирает список и по которому отвечает карточка (Р2). Прежде здесь стояла своя сборка из
    // отдельных осей, и разъехаться с модулем она могла на первой же правке — отдав чужое вложение
    // по прямой ссылке, пока список продолжал бы честно прятать саму заявку (находка Н4).
    //
    // Вместе с общим предикатом сюда приехала и третья ось (Р1): поимённо назначенный исполнитель
    // качает бумаги СВОЕЙ заявки, даже если по роли она вне его площадки. Иначе назначение открывало
    // бы карточку, в которой не открывается ни одно вложение.
    //
    // Вид документа — вторым условием того же запроса (ADR 0160, решение 6): аудитория `requester`
    // видит вложение и гарантийный талон, смета, акт и счёт закрыты. Условие уходит в SQL, а не в
    // разбор после выборки, потому что файл бывает подшит к нескольким заявкам, и вопрос звучит
    // «есть ли ВИДИМАЯ связь», а не «видима ли первая найденная».
    //
    // Архив: удалённая заявка отдаёт документ держателю `archive.read` (Р8). Ветка приоткрыта
    // ровно ему — иначе вкладка «Архив» показывала бы вложение, которое не скачивается, то есть
    // законно открытую карточку с неработающей строкой. Соседние модули этой поблажки не
    // получают: их архив прямой ссылки не открывает, и решение о нём — их собственное.
    const service = await db
      .select({ id: serviceRequests.id })
      .from(serviceRequestFiles)
      .innerJoin(serviceRequests, eq(serviceRequestFiles.requestId, serviceRequests.id))
      .where(
        and(
          eq(serviceRequestFiles.fileId, fileId),
          can(p, 'archive.read') ? undefined : isNull(serviceRequests.deletedAt),
          serviceRequestVisibilityWhere(p),
          serviceFileKindWhere(p),
        ),
      )
      .limit(1);
    visibleService = service.length > 0;
  }

  let visibleWaybill = false;
  if (!visibleWaste && !visibleVehicle && !visibleService && canReadWaybills) {
    // Скан, подшитый к бланку строгой отчётности (миграция 0087): оборот, заполненный заказчиком,
    // отметки, акт.
    //
    // УСЛОВИЙ ДВА, И ВТОРОЕ ПОЯВИЛОСЬ ВМЕСТЕ С ОБЛАСТЬЮ ЖУРНАЛА (ADR 0192). Прежде здесь стояла
    // одна связь, и обоснование звучало «придумывать вложениям область, которой нет у самого
    // журнала, значило бы прятать файл, который портал в строке показывает». Ровно это рассуждение
    // и требует теперь второго условия: у журнала область появилась, и вложение обязано сужаться
    // тем же предикатом, что строка, к которой оно подшито. Без него площадка, получившая набор
    // «Путевые листы: просмотр и печать», открывала бы скан любого листа компании по прямому
    // идентификатору файла — мимо журнала, который ей этот лист не показывает.
    const waybill = await db
      .select({ id: waybillFiles.waybillId })
      .from(waybillFiles)
      .innerJoin(waybills, eq(waybills.id, waybillFiles.waybillId))
      .where(and(eq(waybillFiles.fileId, fileId), waybillVisibilityWhere(p)))
      .limit(1);
    visibleWaybill = waybill.length > 0;
  }

  // Механизация идёт за уже перебранными модулями заявок, а её признак — тем же приёмом, что ниже
  // у парка: цепочка отрицаний, свёрнутая в имя, вместо ещё одного слагаемого в каждом условии.
  const foundBeforeMech = visibleWaste || visibleVehicle || visibleService || visibleWaybill;

  let visibleMech = false;
  if (!foundBeforeMech && can(p, 'mechRequests.read')) {
    // Вложения заявки на аренду малой механизации (план механизации, Р14, миграция 0238). Ветка
    // обязана быть здесь целиком: в `file_is_linked` модуль уже перечислен, то есть его файл
    // перестал быть «ничьим» — без этой ветки его не открыл бы никто, включая тех, кому сама
    // заявка видна. Область — одной колонкой места эксплуатации, тем же предикатом
    // `placeObjectVisibilityWhere`, каким модуль отбирает список: своя копия правил разошлась бы
    // с ним на первой же правке.
    //
    // Удалённая заявка вложений не отдаёт — как у вывоза, техники и оргтехники выше: архив
    // открывает карточку, а не прямую ссылку на файл.
    const mech = await db
      .select({ id: mechRequests.id })
      .from(mechRequestFiles)
      .innerJoin(mechRequests, eq(mechRequestFiles.requestId, mechRequests.id))
      .where(
        and(
          eq(mechRequestFiles.fileId, fileId),
          isNull(mechRequests.deletedAt),
          placeObjectVisibilityWhere(p, mechRequests.objectId),
        ),
      )
      .limit(1);
    visibleMech = mech.length > 0;
  }

  // Дальше — вложения парка: скан акта ТО, скан чека на автозапчасти и фотографии показаний. Одна проверка «связь уже
  // нашлась» вместо растущей цепочки отрицаний: каждый следующий модуль иначе добавлял бы по
  // слагаемому в четыре условия.
  const foundInRequests = foundBeforeMech || visibleMech;

  let visibleMaintenance = false;
  if (!foundInRequests && can(p, 'vehicleMaintenance.read')) {
    // Скан акта выполненных работ, подшитый к записи ТО (миграция 0147). Условие одно — связь:
    // право `vehicleMaintenance.read` даётся на весь парк, области у журнала ТО нет (см.
    // `FileLinkage`). Своё право, а не показания: механику `vehicleReadings.read` не дают
    // намеренно (Р14), и на этой ветке держится единственный доступ службы к собственным актам.
    const maintenance = await db
      .select({ id: vehicleMaintenanceFiles.maintenanceId })
      .from(vehicleMaintenanceFiles)
      .where(eq(vehicleMaintenanceFiles.fileId, fileId))
      .limit(1);
    visibleMaintenance = maintenance.length > 0;
  }

  let visibleReceipt = false;
  if (!foundInRequests && !visibleMaintenance && can(p, 'garage.read')) {
    // Скан чека на автозапчасти (миграция 0243, план `docs/auto-part-receipts-plan.md`, Р20).
    // Право — `garage.read`, ровно то же, под которым открывается сам чек (Р5): третьего права у
    // модуля нет. Условие одно — связь, как у акта ТО выше: своей оси области у службы механика не
    // заведено (`ACCESS_PROFILES`), парк один. Обратная сторона названа прямо: держатель
    // `garage.read` открывает скан любого чека — той же границей живёт журнал ТО.
    //
    // Ветка обязана быть здесь целиком: в `file_is_linked` чеки уже перечислены десятой ветвью
    // (0243), то есть подшитый скан перестал быть «ничьим» — и без этой ветки его не открыл бы
    // НИКТО, включая механика, который его же и загрузил (`uploadedBy` работает только у файла, не
    // привязанного никуда). Дополнять при этом больше нечего: перечень таблиц привязки живёт в
    // одном месте — в функции БД, — а `linkedAnywhere` ниже спрашивает её через `isFileLinked`.
    //
    // Своего `deleted_at` у чека нет — удаление физическое, — поэтому join с шапкой ничего бы не
    // отфильтровал. Пометка на удаление (Р12) скан тоже не прячет: помеченный чек из ленты не
    // исчезает и до решения администратора остаётся обычным документом.
    const receipt = await db
      .select({ id: autoPartReceiptFiles.receiptId })
      .from(autoPartReceiptFiles)
      .where(eq(autoPartReceiptFiles.fileId, fileId))
      .limit(1);
    visibleReceipt = receipt.length > 0;
  }

  const foundBefore = foundInRequests || visibleMaintenance || visibleReceipt;

  let visibleReading = false;
  if (!foundBefore && can(p, 'vehicleReadings.read')) {
    // Фотография приборной панели или чека, подшитая к показанию. Условие одно — связь: право
    // `vehicleReadings.read` даётся на весь парк, области у показаний нет (см. `FileLinkage`).
    const reading = await db
      .select({ id: vehicleReadingFiles.readingId })
      .from(vehicleReadingFiles)
      .where(eq(vehicleReadingFiles.fileId, fileId))
      .limit(1);
    visibleReading = reading.length > 0;
  }

  let ownDriverReading = false;
  // Своя фотография водителя: у него нет права на показания парка, и без этой ветки он не открыл
  // бы даже собственный снимок. Область — четвёртая ось (Р5): человек принципала против человека
  // отчёта, а не «любой файл, привязанный к любому показанию».
  const personId = p.personId;
  if (!foundBefore && !visibleReading && personId && can(p, 'driverCabinet.read')) {
    const own = await db
      .select({ id: vehicleReadingFiles.readingId })
      .from(vehicleReadingFiles)
      .innerJoin(vehicleReadings, eq(vehicleReadingFiles.readingId, vehicleReadings.id))
      .innerJoin(driverDailyReports, eq(vehicleReadings.reportId, driverDailyReports.id))
      .where(and(eq(vehicleReadingFiles.fileId, fileId), eq(driverDailyReports.personId, personId)))
      .limit(1);
    ownDriverReading = own.length > 0;
  }

  // Привязку целиком спрашиваем только у того, кому иначе отказали бы: это ещё несколько запросов.
  const linkedAnywhere =
    foundBefore || visibleReading || ownDriverReading
      ? true
      : uploadedBy === p.id
        ? await isFileLinked(fileId)
        : false;

  const byRecord = decideFileAccess(p, uploadedBy, {
    visibleWaste,
    visibleVehicle,
    visibleService,
    visibleWaybill,
    visibleMech,
    visibleMaintenance,
    visibleReceipt,
    visibleReading,
    ownDriverReading,
    linkedAnywhere,
  });
  if (byRecord) return { via: 'linkedRecord' };

  /*
   * Сквозной аудит распознавания талонов (ADR 0137, решение 8) — последним, и порядок здесь несёт
   * смысл, а не экономию запроса.
   *
   * Право `wasteRequests.ticketAudit` без `wasteRequests.read` не выдаётся (`PERMISSION_REQUIRES`),
   * так что его держатель ведёт и обычную работу: свою площадку, свои заявки, свои талоны. Их он
   * открывает ветками выше — и в журнал просмотров они не попадают. Спроси мы аудит первым, те же
   * открытия стали бы записями «смотрел чужое», и читать журнал стало бы нечем: настоящие переходы
   * через область утонули бы в собственной работе держателя. Журнал заведён про сквозной доступ
   * (§4.2), поэтому и ветка стоит там, где обычный доступ уже отказал.
   */
  if (!can(p, 'wasteRequests.ticketAudit')) return { via: 'denied' };
  const scan = await wasteTicketScan(fileId);
  return scan ? { via: 'ticketAudit', requestId: scan.requestId } : { via: 'denied' };
}

export default async function filesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Право на файл не выводится из роли: файл виден тому, кому видна связанная с ним заявка
  // (а свежезагруженный — тому, кто его загрузил). Проверка — в обработчике, по самой записи.
  const auth = {
    preHandler: [app.authenticate, app.authorizeInHandler('файл виден по связанной заявке')],
  };

  r.post(
    '/upload-session',
    { ...auth, schema: { body: createUploadSessionSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { filename, contentType, size } = req.body;
      if (size > config.files.maxSize) {
        throw err.badRequest(
          `Файл превышает лимит ${Math.floor(config.files.maxSize / 1024 / 1024)} МБ`,
        );
      }
      const objectKey = buildObjectKey(filename);
      const [file] = await db
        .insert(files)
        .values({
          bucket: config.s3.bucket,
          objectKey,
          filename,
          contentType,
          size,
          status: 'pending',
          uploadedBy: p.id,
        })
        .returning();
      const uploadUrl = await presignPut(objectKey, contentType);
      reply.code(201);
      return { fileId: file!.id, uploadUrl, objectKey, expiresIn: config.s3.uploadUrlTtl };
    },
  );

  r.post('/:id/complete', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const [file] = await db.select().from(files).where(eq(files.id, req.params.id));
    if (!file || file.deletedAt) throw err.notFound('Файл не найден');
    /*
     * ВТОРАЯ РУЧКА, ОТДАЮЩАЯ ИМЯ ФАЙЛА, — и она ходит по тому же правилу (план освобождения от
     * подписи, Р6, п. 4). Имя само бывает персональными данными: «Паспорт_Иванова.pdf» в ответе
     * остаётся утечкой и без содержимого, а `toFileDto` ниже отдаёт именно его.
     *
     * Ответ — тот же `404`, что у невидимого файла в ссылке, и тем же текстом: разные коды на «нет
     * такого» и «есть, но не тебе» дают оракул (ADR 0160, решение 6). `403` здесь был бы хуже
     * прежнего: он сообщал бы автору, что его файл заперли по инциденту, — а узнать об этом он
     * должен от людей, ведущих разбор, а не перебором ручек.
     *
     * Проверка стоит ДО авторства, а не после: ответ про карантин не должен зависеть от того, чей
     * это файл, иначе пара ответов `403`/`404` снова различала бы «заперт» и «не существует».
     * Держателю права разбора ручка отвечает по-прежнему — но только на его собственный файл: чужую
     * незаконченную загрузку она не завершала никому и не начинает.
     */
    if (file.quarantinedAt && !can(p, 'files.quarantineAudit')) {
      throw err.notFound('Файл не найден');
    }
    if (file.uploadedBy !== p.id) throw err.forbidden();
    if (file.status === 'active') return toFileDto(file);

    const head = await headObject(file.objectKey);
    if (!head) throw err.badRequest('Файл не найден в хранилище — загрузка не завершена');
    if (head.size > config.files.maxSize) {
      await deleteObject(file.objectKey);
      await db
        .update(files)
        .set({ status: 'deleted', deletedAt: new Date() })
        .where(eq(files.id, file.id));
      throw err.badRequest('Файл превышает допустимый размер');
    }
    // Условное обновление, а не безусловное: между чтением строки выше и этим запросом уборка
    // воркера успевает забрать незавершённую загрузку старше суток — пометить `deleted` и поставить
    // задачу на удаление объекта из S3. Безусловный `SET status='active'` перекрыл бы её метку и
    // оставил живую с виду запись поверх объекта, который вот-вот исчезнет: файл ушёл бы в заявку и
    // перестал открываться позже, без единого следа. Строка меняется только пока она `pending`.
    const [updated] = await db
      .update(files)
      .set({ status: 'active', size: head.size })
      .where(and(eq(files.id, file.id), eq(files.status, 'pending')))
      .returning();
    if (updated) return toFileDto(updated);

    // Ноль строк — значит статус сменился рядом. Перечитываем: `active` мог поставить параллельный
    // повтор того же `complete` (тогда всё в порядке и ответ прежний), а `deleted` — уборка.
    const [after] = await db.select().from(files).where(eq(files.id, file.id));
    if (after && after.status === 'active' && !after.deletedAt) return toFileDto(after);
    throw err.conflict('Загрузка устарела — загрузите файл заново');
  });

  /**
   * Ссылка на файл: по умолчанию — скачивание, `disposition=inline` — показ содержимого
   * (портал вставляет такую ссылку в окно просмотра: картинкой или фреймом).
   * Инлайном отдаются только типы, которые браузер показывает сам (фото талона, PDF); всё
   * остальное всё равно уходит вложением — исполняемая разметка на домене хранилища не нужна.
   */
  r.get(
    '/:id/download',
    { ...auth, schema: { params: idParams, querystring: fileDownloadQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const [file] = await db.select().from(files).where(eq(files.id, req.params.id));
      /*
       * У КАРАНТИННОГО ФАЙЛА СОСТОЯНИЕ ЗАГРУЗКИ БОЛЬШЕ НЕ РЕШАЕТ НИЧЕГО — решает одно правило
       * карантина ниже (план `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р6,
       * п. 4). Карантин ставят и по УЖЕ СНЯТОМУ вложению: связи нет, строка помечена `deleted`, а
       * объект жив, потому что постановка сняла задачу его сноса. Останься здесь прежнее
       * `status !== 'active'`, разбор инцидента не открыл бы ровно тот файл, ради сохранения
       * которого задачу и снимали, — то есть аварийный выход сводился бы к «спрятали и никому».
       *
       * Никому лишнему это не открывает: `canAccessFile` отвечает по карантину первой строкой и
       * всем, кроме права разбора, возвращает отказ — тот же `404`, что у файла, которого нет.
       */
      if (!file || (!file.quarantinedAt && (file.status !== 'active' || file.deletedAt))) {
        throw err.notFound('Файл не найден');
      }
      const access = await canAccessFile(p, file.id, file.uploadedBy, file.quarantinedAt);
      /*
       * `404`, а не `403`, и одинаково для всех модулей (ADR 0160, решение 6). Разные коды на «нет
       * такого файла» и «есть, но не тебе» — это оракул: перебрав идентификаторы, по одному лишь
       * коду ответа читается, сколько у заявки счетов. Разводить коды по модулям бессмысленно —
       * сравнение соседних ответов дало бы тот же оракул, только в два запроса.
       *
       * Отказы по авторству в `POST /:id/complete` и `DELETE /:id` остаются `403`: там речь не о
       * видимости чужой записи, а о действии над своим файлом, существование которого обращающийся
       * и так знает — он его загрузил.
       */
      if (access.via === 'denied') throw err.notFound('Файл не найден');
      const inline = req.query.disposition === 'inline' && isInlineViewable(file.contentType);
      const url = await presignGet(file.objectKey, file.filename, inline ? 'inline' : 'attachment');
      if (access.via === 'quarantineAudit') {
        /*
         * КАЖДЫЙ доступ к карантинному файлу — запись журнала (план освобождения от подписи, Р6,
         * п. 4). Причина жёстче, чем у просмотра талона мимо области: право сквозное НАСКВОЗЬ —
         * карантинный файл приходит из любого модуля, и ни одна область его держателя не сужает.
         * Уравновешено это единственным: видно, кто смотрел. Оттого и запись на каждое открытие, а
         * не «одна на первую постановку»: разбор инцидента сам обязан быть прослеживаемым.
         *
         * Хеш уходит в строку журнала вместе с ссылкой: им доказывается, что смотрели то самое
         * содержимое, которое закрыли, а не подменённый за это время объект хранилища. Пустой хеш —
         * законное состояние (его могло не получиться посчитать), и читается он как «доказательства
         * содержимого нет», а не как «файл не в карантине».
         *
         * `writeAudit`, а не `writeAuditTx`: транзакции здесь нет, а закрытый перечень строгой
         * записи (`lib/audit.ts`) молча не расширяют — просмотр в него не входит.
         */
        await writeAudit({
          actorUserId: p.id,
          action: 'file.quarantine_access',
          entityType: 'file',
          entityId: file.id,
          metadata: {
            filename: file.filename,
            quarantinedAt: file.quarantinedAt?.toISOString() ?? null,
            contentHash: file.contentHash,
            disposition: inline ? 'inline' : 'attachment',
          },
        });
      }
      if (access.via === 'ticketAudit') {
        /*
         * Просмотр скана мимо области — событие журнала (ADR 0137, §4.2). Право сквозное: держатель
         * видит бумагу всех площадок и всех перевозчиков, и единственное, чем это уравновешено, —
         * что видно, кто смотрел. Запись поэтому идёт не на «файл открыт», а на «файл открыт правом
         * аудита»: своя площадка держателя в журнале не появляется.
         *
         * Сущность — файл, а не заявка, как у соседних событий вывоза: заявки может уже не быть
         * (талон снят, заявка откатана), а вопрос к строке всегда про конкретный скан. Заявка
         * уходит в `metadata`, пока она известна: по ней читается, чью площадку смотрели.
         *
         * `writeAudit`, а не `writeAuditTx`: транзакции здесь нет, а закрытый перечень строгой
         * записи (см. `lib/audit.ts`) молча не расширяют — просмотр в него не входит.
         */
        await writeAudit({
          actorUserId: p.id,
          action: 'waste_request.ticket_audit_view',
          entityType: 'file',
          entityId: file.id,
          metadata: { requestId: access.requestId, filename: file.filename },
        });
      }
      return { url, expiresIn: config.s3.downloadUrlTtl };
    },
  );

  r.delete('/:id', { ...auth, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    const [file] = await db.select().from(files).where(eq(files.id, req.params.id));
    if (!file || file.deletedAt) throw err.notFound('Файл не найден');
    // Свой файл удаляет автор загрузки, чужой — тот, кто ведёт заявки.
    if (file.uploadedBy !== p.id && !can(p, 'files.manageAny')) throw err.forbidden();
    /*
     * КАРАНТИННЫЙ ФАЙЛ НЕ УДАЛЯЕТСЯ ВОВСЕ — ни автором, ни держателем `files.manageAny`, ни
     * держателем права разбора (план освобождения от подписи, Р6, п. 4).
     *
     * Пометка «удалён» ставит объекту задачу на физическое удаление из S3 через тридцать суток
     * (`softDeleteFile`), то есть уносит предмет разбора вместе с хешем, которым он доказан.
     * «Доказательство скрыто по обращению» и «доказательства не было» — разные факты, и удаление
     * превратило бы первый во второй руками того, кто чаще всего и есть виновник инцидента.
     *
     * `409`, а не `404`: карантин не секрет — признак `quarantined` виден в карточке заявки всякому,
     * кому видна сама заявка, — и отказ обязан сказать, что делать (сперва снять карантин). Порядок
     * «снять карантин → удалить» оставляет в журнале обе строки с причинами.
     */
    if (file.quarantinedAt) {
      throw err.conflict('Файл в карантине — сначала снимите карантин');
    }
    // Прикреплённый к заявке файл удаляется только через редактирование заявки.
    if (await isFileLinked(file.id)) {
      throw err.conflict('Файл прикреплён к заявке — удалите его через редактирование заявки');
    }
    await softDeleteFile(file.id, file.objectKey);
    return { ok: true };
  });

  /*
   * ── Карантин: аварийный выход для ошибочно загруженного документа (Р6, п. 4) ──
   *
   * Право одно на обе ручки и на чтение содержимого — `files.quarantineAudit`, а не
   * `files.manageAny`. Причин две, и обе про симметрию. Первая: `files.manageAny` приходит МАТРИЦЕЙ
   * роли (он есть у менеджера и диспетчера целиком), а карантин — работа НАЗВАННОГО человека,
   * которому инцидент поручен; право поэтому выдаётся одним системным набором поимённо. Вторая:
   * поставивший карантин обязан видеть, что именно он запер, — иначе он решает наугад, — а
   * снимающий обязан видеть, что открывает обратно. Разведи постановку и чтение по двум правам, и
   * получилась бы пара «закрыть может один, открыть другой», в которой документ теряется.
   */
  const canQuarantine = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'files.quarantineAudit',
        'Недостаточно прав для разбора карантина файлов',
      ),
    ],
  };

  /**
   * Постановка в карантин. Порядок внутри строгий: СНАЧАЛА закрывается доступ, и только потом
   * считается хеш.
   *
   * Почему так — в комментарии колонки `content_hash` (`db/schema.ts`): пары «карантин ⇒ хеш есть» в
   * базе нет намеренно, потому что такое ограничение сделало бы доступность ХРАНИЛИЩА условием
   * закрытия доступа. Хеш считается потоком из S3, а карантин ставят по инциденту с персональными
   * данными — ждать, пока починят сеть, нельзя. Недосчитанный хеш остаётся пустым и уходит в журнал
   * как «посчитать не удалось», а не как «карантин не состоялся».
   */
  r.post(
    '/:id/quarantine',
    { ...canQuarantine, schema: { params: idParams, body: quarantineBodySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { reason } = req.body;
      const [file] = await db.select().from(files).where(eq(files.id, req.params.id));
      if (!file) throw err.notFound('Файл не найден');

      /*
       * СНЯТОЕ ВЛОЖЕНИЕ КАРАНТИНИТСЯ, ПОКА ЖИВ ОБЪЕКТ, — и это не послабление, а сам аварийный
       * выход (план `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р6, п. 4).
       *
       * Порядок событий, при котором карантин вообще нужен, чаще всего именно такой: вложение сняли,
       * а инцидент заметили после — через день или через неделю. Строка файла помечена `deleted`,
       * связи нет, но объект в хранилище живёт ещё тридцать суток, и отказ по одной отметке удаления
       * закрывал бы аварийный выход ровно в том окне, ради которого он заведён: предмет разбора
       * уехал бы по календарю, и доказать, что именно было загружено, стало бы нечем.
       *
       * УНИЧТОЖЕННЫЙ — по-прежнему `404`: карантинить нечего, а обещать сохранность того, чего нет,
       * хуже отказа. «Жив ли объект» спрашивается у собственной очереди, а не у хранилища
       * (`cancelScheduledObjectDeletion`): живая задача сноса означает, что снос ещё не выполнялся.
       */
      const outcome = await db.transaction(async (tx) => {
        /*
         * Блокировка строки на всю постановку: между «прочитали состояние» и «сняли задачу сноса»
         * иначе помещается второй такой же запрос — и снятую первым задачу второй не нашёл бы,
         * ответив `404` по живому файлу, уже стоящему в карантине.
         */
        const [row] = await tx
          .select({ quarantinedAt: files.quarantinedAt, deletedAt: files.deletedAt })
          .from(files)
          .where(eq(files.id, file.id))
          .for('update');
        if (!row) throw err.notFound('Файл не найден');

        /*
         * Задача снимается ТОЛЬКО на первой постановке по снятому вложению: у повторного запроса её
         * уже нет — снял он же, — и отсутствие задачи там означало бы не «объект уничтожен», а
         * «карантин уже стоит». Оттого условие про `quarantinedAt`, а не про одну отметку удаления.
         */
        let deletionCancelled = false;
        if (!row.quarantinedAt && row.deletedAt) {
          deletionCancelled = await cancelScheduledObjectDeletion(tx, file.objectKey);
          if (!deletionCancelled) throw err.notFound('Файл не найден');
        }

        /*
         * Условное обновление — `WHERE quarantined_at IS NULL`, — и оно же делает ручку
         * идемпотентной: повторный запрос (второй клик, повтор после таймаута) не сдвигает время
         * постановки. Время постановки — единственная отметка в самой записи, по которой потом
         * сверяют, что смотрели уже запертый файл; перетри её повтор, и первая запись журнала стала
         * бы ссылаться в будущее.
         */
        const [updated] = await tx
          .update(files)
          .set({ quarantinedAt: new Date() })
          .where(and(eq(files.id, file.id), isNull(files.quarantinedAt)))
          .returning();
        return {
          locked: updated,
          quarantinedAt: updated?.quarantinedAt ?? row.quarantinedAt,
          deletionCancelled,
          detached: row.deletedAt !== null,
        };
      });
      const { locked, quarantinedAt, deletionCancelled, detached } = outcome;

      /*
       * Хеш считается только на первой постановке: у повторной он уже есть, а пересчёт по объекту,
       * который с тех пор мог подменить кто угодно, затёр бы доказательство содержимого — ровно то,
       * ради чего хеш и считают.
       */
      let contentHash = file.contentHash;
      if (locked) {
        contentHash = await contentHashOf(file.objectKey);
        if (contentHash) {
          await db.update(files).set({ contentHash }).where(eq(files.id, file.id));
        }
      }

      await writeAudit({
        actorUserId: p.id,
        action: 'file.quarantine',
        entityType: 'file',
        entityId: file.id,
        metadata: {
          reason,
          filename: file.filename,
          // Имя поля говорит о факте, а не о попытке: пустой хеш читается как «посчитать не
          // удалось», и разбор обязан отличать это от «файл не заперт».
          contentHash,
          hashComputed: contentHash !== null,
          repeated: !locked,
          /*
           * Снятое вложение и снятая задача сноса — в журнал: через месяц только эта строка
           * объясняет, почему объект уцелел, хотя файл помечен удалённым, и почему после снятия
           * карантина отсчёт тридцати суток пошёл заново.
           */
          detached,
          deletionCancelled,
        },
      });

      return {
        id: file.id,
        quarantined: true,
        quarantinedAt: quarantinedAt?.toISOString() ?? null,
        contentHash,
        deletionCancelled,
      };
    },
  );

  /**
   * Снятие карантина: ошибка бывает и здесь — заперли не тот файл либо обращение оказалось
   * неосновательным.
   *
   * Тем же правом и тоже с причиной: запись о снятии — единственный носитель ответа на вопрос
   * «почему документ снова открыт», потому что в самой записи файла после снятия не остаётся ничего.
   * Хеш при этом НЕ стирается: он доказывает, какое содержимое было закрыто, и после снятия остаётся
   * единственным следом того, что разбор вообще был.
   */
  r.post(
    '/:id/quarantine/release',
    { ...canQuarantine, schema: { params: idParams, body: quarantineBodySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { reason } = req.body;
      const [file] = await db.select().from(files).where(eq(files.id, req.params.id));
      if (!file) throw err.notFound('Файл не найден');
      if (!file.quarantinedAt) throw err.conflict('Файл не в карантине');

      const deletionRunAt = await db.transaction(async (tx) => {
        // Снова условно: два одновременных снятия иначе записали бы в журнал две причины на одно
        // событие, и читающий не понял бы, которая из них открыла доступ. Заодно это единственный
        // замок на возврат задачи сноса: пройди оба снятия, файл получил бы две задачи на один
        // объект.
        const [released] = await tx
          .update(files)
          .set({ quarantinedAt: null })
          .where(and(eq(files.id, file.id), isNotNull(files.quarantinedAt)))
          .returning();
        if (!released) throw err.conflict('Файл не в карантине');

        /*
         * СНЯТОЕ ВЛОЖЕНИЕ ВОЗВРАЩАЕТСЯ В СВОЁ ПРЕЖНЕЕ СОСТОЯНИЕ — «снят и ждёт сноса»: постановка
         * карантина задачу сноса сняла, снятие карантина обязано поставить её обратно, иначе
         * ничейный файл остался бы в хранилище навсегда, и аварийный выход превратился бы в способ
         * отменить уборку.
         *
         * Срок отсчитывается ЗАНОВО, от момента снятия карантина, и это не округление, а смысл
         * срока: тридцать суток дают время вернуть ошибочно снятое вложение — человек замечает
         * пропажу документа и приходит за ним. Разбор инцидента этого времени не тратит, он занимает
         * своё; доживай задача прежний срок, файл, пролежавший в карантине месяц, уехал бы из
         * хранилища в ту же минуту, когда карантин сняли.
         *
         * Задача возвращается только снятому вложению: подшитый файл её не имел и иметь не должен.
         */
        return released.deletedAt ? await scheduleObjectDeletion(tx, released.objectKey) : null;
      });

      await writeAudit({
        actorUserId: p.id,
        action: 'file.quarantine_release',
        entityType: 'file',
        entityId: file.id,
        metadata: {
          reason,
          filename: file.filename,
          contentHash: file.contentHash,
          quarantinedAt: file.quarantinedAt.toISOString(),
          // Когда снятое вложение уедет из хранилища: пусто у подшитого файла — ему уезжать некуда.
          deletionScheduledAt: deletionRunAt?.toISOString() ?? null,
        },
      });

      return {
        id: file.id,
        quarantined: false,
        contentHash: file.contentHash,
        deletionScheduledAt: deletionRunAt?.toISOString() ?? null,
      };
    },
  );
}
