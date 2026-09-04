import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  can,
  DEPARTMENT_SCOPED_ROLES,
  formatServiceRequestNumber,
  moduleMailEventLabels,
  OBJECT_SCOPED_ROLES,
  officeEquipmentCandidateStatusLabels,
  officeEquipmentTitle,
  type ModuleMailOutcome,
  type OfficeEquipmentCandidateStatus,
  type ServiceMailTargets,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  constructionObjects,
  counterparties,
  departments,
  officeEquipment,
  officeEquipmentCandidates,
  officeEquipmentTypes,
  serviceRequests,
  users,
} from '../db/schema';
import { config } from '../config';
import { logger } from '../logger';
import { writeAuditTx } from '../lib/audit';
import { accessSubjectColumns, accessSubjectOf } from '../auth/principal';
import { renderMail, type MailContent } from './mail-templates';
import { queuePreparedMail } from './mail';
import { SERVICE_MAIL_ACCOUNT } from './service-request-mail';
import {
  addressOf,
  collectServiceMailRecipients,
  copyRecipients,
  isServiceMailEventEnabled,
  type ServiceMailActor,
  type ServiceMailAudience,
  type ServiceMailAudienceCtx,
  type ServiceMailRecipient,
} from './service-request-mail-audience';

/**
 * ПИСЬМА О СООБЩЕНИИ, ЧТО АППАРАТА НЕТ В СПРАВОЧНИКЕ (план
 * `docs/office-equipment-candidate-plan.md`, §10; общая механика — ADR 0159).
 *
 * Два события и ровно два письма за всю жизнь сообщения: «его надо проверить» — проверяющим,
 * «решение принято» — автору. Механика взята у писем заявки целиком и намеренно: рубильник
 * спрашивается ПЕРВЫМ, письмо ставится ТЕМ ЖЕ `tx`, что и сам факт (atomic-outbox, §5.9 почтового
 * плана), внешняя конфигурация канала читается ДО транзакции, копии добавляются сверх обязательных
 * адресатов, источник-актор вычёркивается, а итог планирования пишется строгим аудитом на КАЖДОМ
 * исходе — иначе «письма не было» разбирать было бы нечем.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ВЕТКА В `service-request-mail.ts`. Тот модуль отвечает на вопрос
 * «кому из СТОРОН ЗАЯВКИ», и вся его середина — `office`/`service`, назначенная компания, поимённые
 * исполнители, потолок частоты со сводкой. У писем кандидата сторон нет ни одной: ящик службы
 * обязательным адресатом здесь не является, подрядчик не участвует вовсе, а адресат считается
 * ПРАВОМ проверяющего и областью сообщения. Втиснутые туда двумя новыми значениями `RequiredTarget`
 * они добавили бы ветку «а это не про заявку» в семь мест подряд — и первая же правка почты заявок
 * сломала бы почту кандидата молча.
 *
 * ЧТО ПРИ ЭТОМ НЕ ДУБЛИРУЕТСЯ. Накопитель адресатов, копии, рубильник, разбор адреса канала и типы
 * получателя берутся из общего `service-request-mail-audience.ts`: правило «первый источник
 * побеждает, актор вычёркивается, адрес нормализуется» обязано быть одно на портал. Своего здесь
 * ровно две вещи — КТО адресат (проверяющие по праву и области; автор сообщения) и ЧТО написано в
 * теле.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ:
 *
 *   · ПОТОЛКА ЧАСТОТЫ И СВОДКИ ОКНА (§5.11 почтового плана). Он защищает от активной заявки, по
 *     которой за час случается десяток событий; у сообщения о технике событий два за всю жизнь, и
 *     второе бывает через день после первого. Заводить ради этого счёт писем под advisory-локом
 *     значило бы платить блокировкой на каждом заведении заявки за поток, которого не бывает;
 *   · ПОВТОРА КНОПКОЙ («отправить ещё раз»). У писем службы он есть, потому что письмо — их
 *     единственный носитель; здесь очередь проверки видна в портале, и «письмо не дошло» лечится
 *     тем, что проверяющий и так смотрит на очередь;
 *   · ТЕЛА ПОДРЯДЧИКА. Сервисная компания к справочнику отношения не имеет: она чинит аппарат по
 *     заявке, а заводит его в парк ИТ-служба. Аудитории `contractor` и `contractor_withdrawn` в
 *     карте полей ниже присутствуют лишь потому, что карта закрыта `Record`, — и получают самое
 *     скупое тело, а не самое полное.
 */

/** Транзакция drizzle: письмо ставится вместе с тем, ради чего оно отправляется. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Два события кандидата. Свой тип, а не весь `ModuleMailEvent`: этот модуль не умеет собирать
 * письмо о заявке, и параметр, принимающий девять значений там, где законны два, обещал бы
 * вызывающему то, чего нет.
 */
export type CandidateMailEvent =
  'office_equipment_candidate_pending' | 'office_equipment_candidate_decided';

/**
 * Подготовка ДО транзакции (§5.9 почтового плана): только то, что читается из конфигурации
 * процесса и не зависит ни от прав, ни от состояния базы. Отказ здесь — мягкий исход, и
 * транзакция идёт дальше без почтовой части.
 *
 * В БАЗУ ЭТА ФУНКЦИЯ НЕ ХОДИТ ВОВСЕ — в отличие от `prepareServiceMail`, который читает адрес
 * автора заявки. Здесь он не нужен: у `pending` автор сообщения И ЕСТЬ актор (пара «кандидат +
 * заявка» создаётся одной транзакцией от его имени, Р2), а у `decided` обратный адрес — ящик
 * службы. Появись однажды заведение «от лица» другого человека — эта строка обязана начать читать
 * автора из строки кандидата, и молчаливо оставить здесь адрес нажавшего кнопку будет нельзя.
 */
export interface CandidateMailPreparation {
  event: CandidateMailEvent;
  ctx: ServiceMailAudienceCtx;
  /** Исход конфигурации: `null` — препятствий нет, дальше решает транзакция. */
  configOutcome: 'mail_disabled' | 'channel_missing' | null;
}

export function prepareCandidateMail(
  event: CandidateMailEvent,
  actor: ServiceMailActor,
): CandidateMailPreparation {
  const channel = config.mail.accounts[SERVICE_MAIL_ACCOUNT];
  const channelEmail = channel.configured ? addressOf(channel.from) : '';
  /**
   * Обратный адрес ВНУТРЕННЕГО тела различается по событию, и это не оттенок (§10):
   *
   *   · у `pending` отвечают АВТОРУ сообщения. Вопрос проверяющего — «а точно ли этот аппарат стоит
   *     в 214-м и точно ли на нём такой номер», и задать его надо тому, кто аппарат видел;
   *   · у `decided` отвечают В СЛУЖБУ. Решение принял проверяющий, но переписка по нему — рабочая
   *     переписка модуля, и ответ обязан попасть тем, кто ведёт справочник, а не в личный ящик
   *     дежурного проверяющего.
   */
  const internalReplyTo =
    event === 'office_equipment_candidate_pending' ? actor.email || channelEmail : channelEmail;
  const configOutcome = !config.mail.enabled
    ? 'mail_disabled'
    : !channelEmail
      ? 'channel_missing'
      : null;
  return { event, ctx: { channelEmail, internalReplyTo, actor }, configOutcome };
}

/** Исход письма целиком плюс разбор по целям: копия не отменяет того, что обязательный не узнал. */
export interface CandidateMailResult {
  outcome: ModuleMailOutcome;
  targets: ServiceMailTargets;
  /** Кому письма поставлены — снимком: адреса пишет аудит, а не лог (у журнала есть право доступа). */
  recipients: ServiceMailRecipient[];
}

/**
 * Что письмо рассказывает о сообщении. Собирается ОДНИМ запросом по строке самого кандидата — тем
 * же приёмом и по той же причине, что `loadServiceLetterData`: два места, собирающих одни и те же
 * поля, разошлись бы на первой правке, а письмо, собранное вторым кодом, проверялось бы не тем
 * тестом.
 */
export interface CandidateLetterData {
  candidateId: string;
  status: OfficeEquipmentCandidateStatus;
  typeName: string;
  declaredModel: string;
  serialNumber: string;
  inventoryNumber: string;
  objectId: string;
  objectCode: string;
  objectName: string;
  location: string;
  comment: string;
  authorId: string;
  authorName: string;
  /** Отдел автора СНИМКОМ (по нему считается отдельская ось очереди); `null` — отделов нет вовсе. */
  authorDepartmentId: string | null;
  authorDepartmentName: string | null;
  decisionReason: string;
  /** Подпись карточки-результата; `null` — решения не было либо оно отказ. */
  resultTitle: string | null;
  /** Единственная связанная заявка (Р4): `null` бывает только у необратимо снесённой пары. */
  requestId: string | null;
  requestNum: number | null;
}

export async function loadCandidateLetterData(
  tx: Tx,
  candidateId: string,
): Promise<CandidateLetterData> {
  const [row] = await tx
    .select({
      c: officeEquipmentCandidates,
      typeName: officeEquipmentTypes.name,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      authorName: users.fullName,
      departmentName: departments.name,
      resultName: officeEquipment.name,
      resultSerialNumber: officeEquipment.serialNumber,
      resultInventoryNumber: officeEquipment.inventoryNumber,
      requestId: serviceRequests.id,
      requestNum: serviceRequests.num,
    })
    .from(officeEquipmentCandidates)
    /*
     * Тип, площадка и автор — `innerJoin`: все три колонки `NOT NULL` со ссылкой `restrict`, и
     * строка без них невозможна. `leftJoin` здесь обещал бы состояние, которого база не допускает,
     * и прятал бы настоящую поломку данных за пустым полем письма.
     */
    .innerJoin(
      officeEquipmentTypes,
      eq(officeEquipmentTypes.id, officeEquipmentCandidates.equipmentTypeId),
    )
    .innerJoin(constructionObjects, eq(constructionObjects.id, officeEquipmentCandidates.objectId))
    .innerJoin(users, eq(users.id, officeEquipmentCandidates.createdBy))
    .leftJoin(departments, eq(departments.id, officeEquipmentCandidates.requesterDepartmentId))
    .leftJoin(officeEquipment, eq(officeEquipment.id, officeEquipmentCandidates.resultEquipmentId))
    // Заявка — `leftJoin` намеренно: пары без заявки не бывает по построению (Р4), но `null`
    // честнее выдуманной строки — необратимый purge заявки уносит и кандидата, и письмо об уже
    // снесённой паре собираться не должно вовсе.
    .leftJoin(
      serviceRequests,
      eq(serviceRequests.equipmentCandidateId, officeEquipmentCandidates.id),
    )
    .where(eq(officeEquipmentCandidates.id, candidateId));
  if (!row) throw new Error(`Сообщение о технике ${candidateId} не найдено при сборке письма`);
  return {
    candidateId,
    status: row.c.status,
    typeName: row.typeName,
    declaredModel: row.c.declaredModel,
    serialNumber: row.c.serialNumber,
    inventoryNumber: row.c.inventoryNumber,
    objectId: row.c.objectId,
    objectCode: row.objectCode,
    objectName: row.objectName,
    location: row.c.location,
    comment: row.c.comment,
    authorId: row.c.createdBy,
    authorName: row.authorName,
    authorDepartmentId: row.c.requesterDepartmentId,
    authorDepartmentName: row.departmentName,
    decisionReason: row.c.decisionReason,
    resultTitle:
      row.resultName === null
        ? null
        : officeEquipmentTitle({
            name: row.resultName,
            serialNumber: row.resultSerialNumber ?? '',
            inventoryNumber: row.resultInventoryNumber ?? '',
          }),
    requestId: row.requestId,
    requestNum: row.requestNum,
  };
}

// ── Адресаты ──

/**
 * ПРОВЕРЯЮЩИЕ, КОТОРЫМ ЭТО СООБЩЕНИЕ ВИДНО (Р9, §10).
 *
 * ПРАВО СЧИТАЕТСЯ ЭФФЕКТИВНОЕ, А НЕ КОД НАБОРА. Субъект собирается теми же выражениями, что у
 * `loadPrincipal` (`accessSubjectColumns`, `accessSubjectOf`), а ответ даёт `can(subject,
 * 'officeEquipment.review')` из контрактов — ровно тем же приёмом, что и `executeSubjectsOf` у
 * писем заявки. Отбор «у кого набор `…_operator`» был бы короче и неверен дважды: законный набор,
 * собранный администратором руками, почта бы потеряла, а снятое право продолжало бы слать письма,
 * пока кто-нибудь не заметит.
 *
 * ОБЛАСТЬ — ЗЕРКАЛО `officeEquipmentCandidateReviewWhere`, и классификаторы ролей берутся ОТТУДА ЖЕ
 * (`OBJECT_SCOPED_ROLES`, `DEPARTMENT_SCOPED_ROLES`), а не переписываются списком имён: тот
 * предикат отвечает «какие сообщения видит этот проверяющий», а здесь задан обратный вопрос — «кто
 * из проверяющих видит это сообщение», — и разойдись два ответа, письмо ушло бы тому, у кого
 * строки в очереди нет, либо не ушло бы тому, у кого она есть. Ось у роли одна: объектная роль
 * ловится площадкой сообщения, отдельская — отделом автора, роль без оси видит очередь всей
 * компании.
 *
 * СЫРОЙ `EXISTS` В ПОДЗАПРОСАХ — по той же причине, что у соседей в `lib/access.ts`: собранный
 * построителем коррелированный подзапрос в односоставном запросе drizzle молча теряет корреляцию
 * (`office-equipment-sql-correlation.test.ts`), то есть отдал бы «есть ли вообще хоть одна привязка
 * к этой площадке» вместо «есть ли она у ЭТОГО человека».
 *
 * АДМИНИСТРАТОР ИСКЛЮЧЁН ЯВНО (§10): проверить сообщение он может, но рассылать очередь всем
 * администраторам компании незачем — для наблюдения есть строка копии, которую заводят осознанно.
 * Учётка внешнего исполнителя отсекается сама: право `officeEquipment.review` типу контрагента не
 * выдаётся, и `can` ответит «нет» — отдельного условия для неё здесь нет намеренно, иначе правило
 * доступа было бы записано в двух местах.
 *
 * `FOR SHARE` ПО ОТСОРТИРОВАННОМУ ID И ДО ВЫЧИСЛЕНИЯ ПРАВ — приём и довод `executeSubjectsOf`:
 * отзыв набора, закоммиченный раньше блокировки, адресата исключает, а конкурентный отзыв
 * сериализуется с созданием строк очереди. Сортировка по id — против взаимной блокировки.
 */
export async function reviewerRecipients(
  tx: Tx,
  place: { objectId: string; authorDepartmentId: string | null },
  ctx: ServiceMailAudienceCtx,
): Promise<ServiceMailRecipient[]> {
  const objectRoles = [...OBJECT_SCOPED_ROLES];
  const departmentRoles = [...DEPARTMENT_SCOPED_ROLES];
  const onObject = and(
    inArray(users.role, objectRoles),
    sql`EXISTS (SELECT 1 FROM user_construction_objects uco
                 WHERE uco.user_id = ${users.id}
                   AND uco.construction_object_id = ${place.objectId})`,
  );
  /*
   * У сообщения без отдела автора (площадочная роль, администратор) отдельской ветви нет вовсе, а
   * не «пустой список отделов»: `ud.department_id = NULL` не совпадёт ни с чем и молча превратил бы
   * условие в «никогда», что верно по результату и неверно по смыслу — читателю следующей правки
   * показалось бы, что отдельский проверяющий отобран и просто не нашёлся.
   */
  const inDepartment = place.authorDepartmentId
    ? and(
        inArray(users.role, departmentRoles),
        sql`EXISTS (SELECT 1 FROM user_departments ud
                     WHERE ud.user_id = ${users.id}
                       AND ud.department_id = ${place.authorDepartmentId})`,
      )
    : undefined;
  // Роль без оси — очередь всей компании: ровно на этой ветке держится обещание плана, что у
  // каждого сообщения есть адресат (площадочного проверяющего на каждом объекте не бывает).
  const withoutAxis = notInArray(users.role, [...objectRoles, ...departmentRoles]);
  const scope = or(...([onObject, inDepartment, withoutAxis].filter(Boolean) as SQL[]));

  const rows = await tx
    .select({ id: users.id, email: users.email, ...accessSubjectColumns })
    .from(users)
    .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id))
    .where(
      and(
        eq(users.isActive, true),
        isNull(users.deletedAt),
        // Учётка без адреса — ящик, которого нет: письмо ей не собирается вовсе, а не уходит в
        // пустоту и не ломает счёт обязательной цели.
        ne(users.email, ''),
        // Роль спрашивается ДО права: `can` учётке без роли всё равно ничего не даст, но без этого
        // условия она проехала бы ветку «роль без оси» и попала бы в блокировку строк напрасно.
        isNotNull(users.role),
        ne(users.role, 'admin'),
        scope,
      ),
    )
    .orderBy(users.id)
    // `OF users`: блокируется строка учётки, а не карточка контрагента. Внешнее соединение свою
    // нулевую сторону блокировать и не даёт — PostgreSQL отказал бы запросу целиком.
    .for('share', { of: users });

  return rows
    .filter((row) => can(accessSubjectOf(row), 'officeEquipment.review'))
    .map((row) => ({
      key: row.id,
      email: row.email,
      replyTo: ctx.internalReplyTo,
      audience: 'internal' as const,
      source: 'internal_user' as const,
      sortId: row.id,
      counterpartyId: null,
    }));
}

/**
 * АВТОР СООБЩЕНИЯ — единственный обязательный адресат письма о решении (§10).
 *
 * Отдельной выборкой, а не полем `loadCandidateLetterData`, ровно ради `FOR SHARE`: адресат обязан
 * быть заблокирован до того, как решится его судьба, — тем же приёмом, что и проверяющие выше.
 * Отключённая, удалённая и безадресная учётка адресатом не становятся: это ящик, за которым никого
 * нет, и молчаливая отправка туда хуже честного `no_recipients`.
 *
 * Права здесь НЕ спрашиваются, и это не пропуск: письмо отвечает на вопрос человека о ЕГО
 * собственном сообщении, а право `officeEquipment.propose` могли снять уже после отправки. Отобрав
 * ответ вместе с правом, портал оставил бы заявителя с сообщением, о судьбе которого он не узнает
 * ниоткуда.
 */
export async function candidateAuthorRecipients(
  tx: Tx,
  authorId: string,
  ctx: ServiceMailAudienceCtx,
): Promise<ServiceMailRecipient[]> {
  const rows = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, authorId),
        eq(users.isActive, true),
        isNull(users.deletedAt),
        ne(users.email, ''),
      ),
    )
    .for('share');
  return rows.map((row) => ({
    key: row.id,
    email: row.email,
    replyTo: ctx.internalReplyTo,
    audience: 'internal' as const,
    source: 'internal_user' as const,
    sortId: row.id,
    counterpartyId: null,
  }));
}

// ── Постановка письма ──

/**
 * Ставит письмо события внутри уже открытой транзакции — той самой, которая заводит пару «кандидат
 * + заявка» либо принимает решение (Р13, шаг 7).
 *
 * ПОРЯДОК ШАГОВ ОБЯЗАТЕЛЕН И ТОТ ЖЕ, ЧТО У ПИСЕМ ЗАЯВКИ (§5.10): рубильник спрашивается ПЕРВЫМ и
 * переопределяет уже вычисленный исход конфигурации — если писать не велено, состояние ящиков к
 * делу не относится, и `no_recipients` звал бы заводить адресата там, где письма никто не просил.
 * Затем конфигурация, затем адресаты и только потом тела.
 *
 * ГРАНИЦА ОТКАЗОВ ТА ЖЕ: SQL-ошибка чтения адресатов или вставки в очередь ЛЕТИТ НАРУЖУ и
 * откатывает решение целиком — прятать потерю атомарного outbox под словами «сбой почты» значило бы
 * отвечать человеку «письмо не собралось» там, где не сохранилось ничего. Ошибка сборки ТЕЛА
 * мягкая: факт есть, письма нет.
 */
export async function queueCandidateMail(
  tx: Tx,
  params: {
    prepared: CandidateMailPreparation;
    candidateId: string;
    /**
     * Исход решения; есть только у `..._candidate_decided`. Он же — вторая половина якоря
     * дедупликации: у сообщения решение одно и навсегда (Р15), но ключ обязан говорить, О ЧЁМ
     * письмо, — иначе будущее «передумали и решили заново» подавилось бы ключом первого решения.
     */
    decision?: Exclude<OfficeEquipmentCandidateStatus, 'pending'>;
  },
): Promise<CandidateMailResult> {
  const { prepared, candidateId } = params;
  const { ctx } = prepared;
  const targets: ServiceMailTargets = {};

  /**
   * Единственный выход из функции, и он же — единственное место записи следа. След обязан
   * оставаться на КАЖДОМ исходе, а не только на успешном: «письма не было» разбирают через месяц, и
   * `event_off` (администратор выключил) от `no_recipients` (проверяющих нет ни одного) отличает
   * как раз эта запись. У `queued` строки очереди есть и без неё, у остальных исходов — нет ничего.
   *
   * `writeAuditTx`, а не общий `writeAudit`: запись, сделанная мимо транзакции, пережила бы её
   * откат и рассказывала бы о письме, которого не планировалось (перечень строгого аудита —
   * `lib/audit.ts`, пункт 8).
   */
  const finish = async (
    outcome: ModuleMailOutcome,
    recipients: ServiceMailRecipient[] = [],
  ): Promise<CandidateMailResult> => {
    await writeAuditTx(tx, {
      actorUserId: ctx.actor.id,
      action: 'officeEquipmentCandidate.mailPlanned',
      entityType: 'officeEquipmentCandidate',
      entityId: candidateId,
      // Адреса — в журнал, а не в лог: у аудита есть право доступа, у логов его нет.
      metadata: {
        event: prepared.event,
        outcome,
        targets,
        recipients: recipients.map((r) => r.email),
        sources: recipients.map((r) => r.source),
      },
    });
    logger.info(
      {
        candidateId,
        event: prepared.event,
        outcome,
        recipients: recipients.length,
      },
      'письмо о сообщении про технику: итог планирования',
    );
    return { outcome, targets, recipients };
  };

  if (!(await isServiceMailEventEnabled(tx, prepared.event))) return finish('event_off');
  if (prepared.configOutcome) return finish(prepared.configOutcome);

  const data = await loadCandidateLetterData(tx, candidateId);
  const pending = prepared.event === 'office_equipment_candidate_pending';
  const candidates = pending
    ? await reviewerRecipients(
        tx,
        { objectId: data.objectId, authorDepartmentId: data.authorDepartmentId },
        ctx,
      )
    : await candidateAuthorRecipients(tx, data.authorId, ctx);
  // Копии — последними: первый источник побеждает, и доверенное тело не подменяется наблюдательским.
  candidates.push(...(await copyRecipients(tx, prepared.event, ctx)));
  const recipients = collectServiceMailRecipients(candidates, ctx.actor);

  if (recipients.length > 0) {
    /**
     * Тела собираются только тех аудиторий, которые есть среди адресатов. Ошибка сборки тела —
     * обычное исключение приложения: оно ловится до следующей SQL-команды и даёт мягкий исход
     * `mail_failed` (сообщение принято, письма нет).
     */
    let letters: Partial<Record<ServiceMailAudience, RenderedLetter>>;
    try {
      letters = {};
      for (const audience of new Set(recipients.map((r) => r.audience))) {
        letters[audience] = renderCandidateLetter(prepared.event, data, audience, params.decision);
      }
    } catch (e) {
      logger.error(
        { err: e, candidateId },
        'Письмо о сообщении про технику не собралось: сообщение сохранено, письма нет',
      );
      return finish('mail_failed');
    }
    const anchor = pending ? candidateId : `${candidateId}-${params.decision}`;
    for (const recipient of recipients) {
      await queuePreparedMail(
        {
          kind: prepared.event,
          /**
           * Ключ собран как `событие:якорь:адресат` — тем же способом, что у писем заявки, и
           * ДЕФИС в составном якоре не косметика: двоеточие сдвинуло бы адресата на четвёртое поле,
           * и письмо перестало бы находиться там, где его ищут разбор очереди и тесты. План §10
           * пишет якорь решения как `candidateId:<решение>` — это запись смысла, а не строки.
           */
          dedupeKey: `${prepared.event}:${anchor}:${recipient.key}`,
          to: recipient.email,
          account: SERVICE_MAIL_ACCOUNT,
          replyTo: recipient.replyTo,
          subject: letters[recipient.audience]!.subject,
          text: letters[recipient.audience]!.text,
          html: letters[recipient.audience]!.html,
          entityType: 'officeEquipmentCandidate',
          entityId: candidateId,
        },
        { tx },
      );
    }
  }

  return finish(outcomeOf(prepared, data, recipients, targets), recipients);
}

/**
 * Общий исход по ОБЯЗАТЕЛЬНОЙ цели события. Копия на него не влияет: она наблюдатель, и её письмо
 * не отменяет того, что сообщение некому проверить, а заявитель о решении не узнал.
 *
 * `not_needed` у решения — третье состояние рядом с «ушло» и «не дошло»: письма нет, и это
 * правильно. Так кончается решение, принятое САМИМ автором сообщения (у проверяющего бывает и право
 * сообщать): его источник вычеркнут исключением актора, и `no_recipients` тут звал бы заводить ящик
 * там, где адресат просто узнал о решении раньше письма — своим же нажатием кнопки.
 */
function outcomeOf(
  prepared: CandidateMailPreparation,
  data: CandidateLetterData,
  recipients: ServiceMailRecipient[],
  targets: ServiceMailTargets,
): ModuleMailOutcome {
  const reached = recipients.some((r) => r.source === 'internal_user');
  if (recipients.some((r) => r.source === 'copy')) targets.copies = 'queued';
  if (prepared.event === 'office_equipment_candidate_pending') {
    targets.reviewers = reached ? 'queued' : 'no_recipients';
    return reached ? 'queued' : 'no_recipients';
  }
  const authorIsActor = data.authorId === prepared.ctx.actor.id;
  targets.author = reached ? 'queued' : authorIsActor ? 'not_needed' : 'no_recipients';
  return targets.author;
}

// ── Тела писем ──

interface RenderedLetter {
  subject: string;
  text: string;
  html: string;
}

/**
 * Что аудитории разрешено видеть в теле (§5.6 почтового плана, ADR 0159, решение 7).
 *
 * Карта, а не россыпь `if` по телу: состав полей — это правило доступа, и новое поле обязано
 * ответить на вопрос доступа в тот момент, когда его добавляют, а не когда о нём вспомнят.
 *
 * КОПИЯ УРЕЗАНА, И ЗДЕСЬ ЭТО ВАЖНЕЕ, ЧЕМ У ЗАЯВОК. `module_mail_recipients` хранит произвольный
 * email без проверяемого субъекта, а тело `pending` целиком состоит из наблюдения человека: «в
 * кабинете 214 у бухгалтерии стоит вот это, наклейки нет». Копии остаётся то, ради чего её заводят,
 * — «по этой заявке случилось вот это»: номер, событие и обозначение техники, которое человек и так
 * ввёл сам. Место, отдел, автор, его комментарий, дословная причина отказа и ссылка в портал ей
 * закрыты.
 *
 * АУДИТОРИИ ПОДРЯДЧИКА СТОЯТ РАДИ ЗАКРЫТОГО `Record` и получают самое скупое тело. Письма о
 * справочнике сервисной компании не адресуются вовсе — она чинит аппарат, а заводит его в парк
 * ИТ-служба, — и если такая аудитория здесь однажды появится, пусть она появится с телом копии, а
 * не с полным.
 */
interface CandidateLetterFields {
  /** Площадка и место установки — «где искать аппарат». */
  place: boolean;
  department: boolean;
  /** Кто сообщил. */
  author: boolean;
  /** Свободный текст человека: комментарий заявителя и дословная причина отказа. */
  freeText: boolean;
  /** Ссылка в портал. */
  portalLink: boolean;
}

const CANDIDATE_LETTER_FIELDS = {
  internal: { place: true, department: true, author: true, freeText: true, portalLink: true },
  copy: { place: false, department: false, author: false, freeText: false, portalLink: false },
  contractor: {
    place: false,
    department: false,
    author: false,
    freeText: false,
    portalLink: false,
  },
  contractor_withdrawn: {
    place: false,
    department: false,
    author: false,
    freeText: false,
    portalLink: false,
  },
} satisfies Record<ServiceMailAudience, CandidateLetterFields>;

/** Номера единицы одной строкой: их печатает производитель и клеит бухгалтерия. */
function numbersOf(data: CandidateLetterData): string {
  return [
    data.inventoryNumber ? `инв. ${data.inventoryNumber}` : '',
    data.serialNumber ? `SN ${data.serialNumber}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** «Kyocera ECOSYS M3145 · инв. 0012345» — та же подпись, что в очереди и в отказе рубежа 1. */
function candidateTitle(data: CandidateLetterData): string {
  const numbers = numbersOf(data);
  return numbers ? `${data.declaredModel} · ${numbers}` : data.declaredModel;
}

/**
 * Тело письма — самодостаточное. Ссылка в портал есть только у своих: у копии за адресом нет
 * субъекта, и приглашение «откройте» привело бы её на форму входа.
 *
 * ССЫЛКА `pending` ВЕДЁТ НА ВКЛАДКУ «ТЕХНИКА», А НЕ В САМУ ОЧЕРЕДЬ, и это осознанная неполнота:
 * подвкладку «На проверке» и её параметр заводит этап портала (Э6 плана), а ссылка на параметр,
 * которого ещё нет, обещала бы человеку ход и приводила бы его на пустой список. Как только у
 * подвкладки появится свой параметр, ссылка обязана получить его здесь — искать второе место не
 * придётся.
 *
 * ССЫЛКА `decided` ВЕДЁТ НА КАРТОЧКУ ЗАЯВКИ, а не на сообщение: своего экрана у сообщения для
 * автора нет намеренно (§8 плана — «списка моих кандидатов у заявителя не бывает»), состояние
 * проверки встроено в его же заявку, и туда человеку и надо.
 */
function buildCandidateLetter(
  event: CandidateMailEvent,
  data: CandidateLetterData,
  audience: ServiceMailAudience,
  decision?: Exclude<OfficeEquipmentCandidateStatus, 'pending'>,
): { subject: string; content: MailContent } {
  const fields = CANDIDATE_LETTER_FIELDS[audience];
  const number = data.requestNum === null ? '' : formatServiceRequestNumber(data.requestNum);
  const eventLabel = moduleMailEventLabels[event];
  // Номер заявки в теме, потому что по нему письмо ищут в почте и им же его называют в разговоре;
  // у пары без заявки (необратимый purge) остаётся одно событие — врать про номер нечем.
  const subject = number ? `${number} · ${eventLabel}` : eventLabel;

  const decided = event === 'office_equipment_candidate_decided';
  if (decided && !decision) {
    /*
     * Письмо о решении без решения — не пустая строка, а признак того, что вызывающий поставил
     * письмо не там: исход пишется той же транзакцией, что и статус. Молчать тут нельзя — отказ
     * ловит вызывающий и отвечает `mail_failed`, то есть «письма нет» будет сказано вслух, а не
     * показано пробелом в теле.
     */
    throw new Error(
      `Сообщение ${data.candidateId}: письмо о решении собирается, а исхода решения нет`,
    );
  }

  const lines = [
    `Техника: ${candidateTitle(data)}`,
    `Тип: ${data.typeName}`,
    ...(fields.place
      ? [`Где стоит: ${data.objectCode} — ${data.objectName}, ${data.location}`]
      : []),
    ...(fields.department && data.authorDepartmentName
      ? [`Отдел заявителя: ${data.authorDepartmentName}`]
      : []),
    ...(fields.author ? [`Сообщил: ${data.authorName}`] : []),
    ...(number ? [`Заявка: ${number}`] : []),
    ...(decided ? [`Исход: ${officeEquipmentCandidateStatusLabels[decision!]}`] : []),
    /*
     * ПОДПИСЬ ЗАВЕДЁННОЙ КАРТОЧКИ — ТОЛЬКО У ПОДТВЕРЖДЕНИЯ (§10, Р10 второй редакции). При
     * объединении целевую карточку выбрал проверяющий в СВОЕЙ области, и она может числиться за
     * чужим подразделением — реквизитов чужих карточек письмо не называет. Что стало предметом
     * заявки, автор увидит в самой заявке, с её собственной проверкой области.
     */
    ...(decided && decision === 'confirmed' && data.resultTitle
      ? [`Карточка в справочнике: ${data.resultTitle}`]
      : []),
  ];

  const content: MailContent = {
    title: number ? `${number} — ${eventLabel}` : eventLabel,
    blocks: [
      { kind: 'lines' as const, lines },
      /*
       * Комментарий заявителя и причина отказа — свободный текст человека, и оба идут отдельным
       * блоком, а не строкой перечня: их читают целиком. Заголовок блока совпадает с подписью поля
       * в портале — письмо и карточка обязаны называть одно и то же одинаково.
       */
      ...(fields.freeText && !decided && data.comment
        ? [
            { kind: 'heading' as const, text: 'Что написал заявитель' },
            { kind: 'paragraph' as const, text: data.comment },
          ]
        : []),
      ...(fields.freeText && decided && decision === 'rejected' && data.decisionReason
        ? [
            { kind: 'heading' as const, text: 'Причина отказа' },
            { kind: 'paragraph' as const, text: data.decisionReason },
          ]
        : []),
      ...(fields.portalLink
        ? [
            decided && data.requestId
              ? {
                  kind: 'link' as const,
                  // `open`, а не `id`: карточку открывает именно этот параметр
                  // (`shared/lib/useOpenedRecord.ts`), и письмо с `id` привело бы человека на
                  // список, где заявку ищут глазами.
                  href: `${config.publicOrigin}/office-equipment?tab=requests&open=${data.requestId}`,
                  label: 'Открыть заявку в портале',
                }
              : {
                  kind: 'link' as const,
                  href: `${config.publicOrigin}/office-equipment?tab=equipment`,
                  label: 'Открыть «Технику» в портале',
                },
          ]
        : []),
      {
        kind: 'note' as const,
        /*
         * Приписка обязана говорить правду про обратный адрес — иначе адресат получает
         * неисполнимое указание. Копия про адрес ответа не утверждает ничего лишнего: у строки
         * настройки свой режим, и ответ ей всё равно уходит в службу (ADR 0159, решение 8).
         */
        text:
          audience !== 'internal'
            ? 'Это копия письма по сообщению о технике — без подробностей: их читают в портале. ' +
              'Ответ на это письмо уйдёт в службу оргтехники.'
            : decided
              ? 'Ответ на это письмо уйдёт в службу оргтехники.'
              : 'Проверьте сообщение в портале: заведите карточку, объедините с уже заведённой ' +
                'или отклоните с причиной — её заявитель прочитает дословно. Ответ на это письмо ' +
                'уйдёт заявителю.',
      },
    ],
  };
  return { subject, content };
}

/** Готовое письмо: тема и отрисованное тело — то, что уходит в очередь. */
export function renderCandidateLetter(
  event: CandidateMailEvent,
  data: CandidateLetterData,
  audience: ServiceMailAudience = 'internal',
  decision?: Exclude<OfficeEquipmentCandidateStatus, 'pending'>,
): RenderedLetter {
  const letter = buildCandidateLetter(event, data, audience, decision);
  const rendered = renderMail(letter.content);
  return { subject: letter.subject, text: rendered.text, html: rendered.html };
}

/**
 * То же письмо, но ДО отрисовки — темой и `MailContent`. Нужна отладочной отправке
 * (`POST /admin/mail/test`): она помечает письмо словом «ТЕСТ», а помечать умеет только
 * `MailContent`. Собирать образец вторым кодом нельзя — проверка вёрстки проверяла бы не то письмо,
 * что уходит людям.
 */
export function candidateLetterContent(
  event: CandidateMailEvent,
  data: CandidateLetterData,
  audience: ServiceMailAudience = 'internal',
  decision?: Exclude<OfficeEquipmentCandidateStatus, 'pending'>,
): { subject: string; content: MailContent } {
  return buildCandidateLetter(event, data, audience, decision);
}
