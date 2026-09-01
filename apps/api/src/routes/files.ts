import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  can,
  createUploadSessionSchema,
  fileDownloadQuerySchema,
  type FileDto,
  isInlineViewable,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import {
  driverDailyReports,
  files,
  type FileRow,
  mechRequestFiles,
  mechRequests,
  requestFiles,
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
} from '../db/schema';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { requirePrincipal } from '../auth/plugin';
import {
  lessorVisibilityWhere,
  operatorVisibilityWhere,
  serviceExecutorVisibilityWhere,
  serviceRequestScopeWhere,
  placeObjectVisibilityWhere,
  vehicleRequestVisibilityWhere,
} from '../lib/access';
import { isFileLinked } from '../services/request-files';
import type { Principal } from '../auth/principal';
import { buildObjectKey, deleteObject, headObject, presignGet, presignPut } from '../lib/s3';
import { enqueueJob, JOB_DELETE_S3_OBJECT } from '../lib/jobs';

const idParams = z.object({ id: z.string().uuid() });
const S3_DELETE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

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
  { via: 'denied' } | { via: 'linkedRecord' } | { via: 'ticketAudit'; requestId: string | null };

async function canAccessFile(
  p: Principal,
  fileId: string,
  uploadedBy: string | null,
): Promise<FileAccess> {
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
    // Документы заявки на обслуживание оргтехники (ADR 0084, миграция 0105). Область — та же, что
    // в списке заявок, и считается теми же функциями: две оси заказчика (объект, где стоит
    // техника, и оба отдела — подавший заявку и владелец единицы) плюс контрагент исполнителя.
    // Своя копия правил здесь разъехалась бы с модулем на первой же правке — и отдала бы чужое
    // вложение по прямой ссылке, пока список продолжал бы честно прятать саму заявку.
    const service = await db
      .select({ id: serviceRequests.id })
      .from(serviceRequestFiles)
      .innerJoin(serviceRequests, eq(serviceRequestFiles.requestId, serviceRequests.id))
      .where(
        and(
          eq(serviceRequestFiles.fileId, fileId),
          isNull(serviceRequests.deletedAt),
          serviceRequestScopeWhere(
            p,
            serviceRequests.equipmentObjectId,
            serviceRequests.customerDepartmentId,
            serviceRequests.equipmentDepartmentId,
          ),
          serviceExecutorVisibilityWhere(p, serviceRequests.serviceCounterpartyId),
        ),
      )
      .limit(1);
    visibleService = service.length > 0;
  }

  let visibleWaybill = false;
  if (!visibleWaste && !visibleVehicle && !visibleService && canReadWaybills) {
    // Скан, подшитый к бланку строгой отчётности (миграция 0087): оборот, заполненный заказчиком,
    // отметки, акт. Условие одно — связь: журнал листов не сужается ни объектом, ни контрагентом
    // (`GET /waybills` фильтрует только запрошенным), и придумывать вложениям область, которой нет
    // у самого журнала, значило бы прятать файл, который портал в строке показывает.
    const waybill = await db
      .select({ id: waybillFiles.waybillId })
      .from(waybillFiles)
      .where(eq(waybillFiles.fileId, fileId))
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

  // Дальше — вложения парка: скан акта ТО и фотографии показаний. Одна проверка «связь уже
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

  const foundBefore = foundInRequests || visibleMaintenance;

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
      if (!file || file.status !== 'active' || file.deletedAt) throw err.notFound('Файл не найден');
      const access = await canAccessFile(p, file.id, file.uploadedBy);
      if (access.via === 'denied') throw err.forbidden();
      const inline = req.query.disposition === 'inline' && isInlineViewable(file.contentType);
      const url = await presignGet(file.objectKey, file.filename, inline ? 'inline' : 'attachment');
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
    // Прикреплённый к заявке файл удаляется только через редактирование заявки.
    if (await isFileLinked(file.id)) {
      throw err.conflict('Файл прикреплён к заявке — удалите его через редактирование заявки');
    }
    await softDeleteFile(file.id, file.objectKey);
    return { ok: true };
  });
}
