import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  completionApplySchema,
  completionPreviewSchema,
  uuidSchema,
  type CompletionPreviewDto,
  type LinearDayRef,
  type RequestStatus,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import {
  specialEquipmentRequestDetails,
  vehicleRequestAssignments,
  vehicleRequestCompletions,
  vehicleRequests,
  vehicles,
} from '../db/schema';
import { assertLessorScope, assertRequestScope, assertTransitionAllowed } from '../lib/access';
import { err } from '../lib/errors';
import { previewAssignmentCommand, runAssignmentCommand } from '../services/assignment-command';
import {
  assertCompletionPaperAccess,
  completionAsOf,
  completionCommandSpec,
  completionPreviewDto,
  planCompletionCommand,
  type CompletionApplied,
  type CompletionPaper,
  type CompletionPlan,
} from '../services/assignment-completion';

/**
 * Закрытие заказа техники **фактической датой** — `POST /vehicle-requests/:id/completion/preview` и
 * `POST /vehicle-requests/:id/completion` (`docs/vehicle-request-actual-end-date-plan.md`, Р1, Р22).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ РОУТ-МОДУЛЬ. Тем же приёмом, каким рядом стоят дверь машиниста, дверь ремонта,
 * периодная коррекция и правка срока: `vehicle-requests.ts` — барьерный файл, которого одновременно
 * хотят все двери истории, и дописанные в него они конфликтуют при любом порядке работ. Префикс тот
 * же — `/api/v1/vehicle-requests`: адреса портала от разделения не меняются.
 *
 * ЧТО ПРОИСХОДИТ СО СТАРЫМ ПУТЁМ. Пока — ничего: `PATCH /:id/status` по-прежнему принимает `done` и
 * закрывает заказ, не трогая срок. Запрет придёт **вторым выпуском** вместе с порталом (Р1, Э14):
 * сервер и окно катятся парой, потому что разъехавшаяся пара оставила бы дорогу в обход
 * фактической даты. До тех пор две двери живут рядом, и обе пишут один и тот же факт одним и тем же
 * разбором (`services/vehicle-request-completion.ts`).
 *
 * ПРАВА — СОСТАВНОЙ КОНТРАКТ (Р22), и безусловное здесь ровно одно:
 *
 * ```
 * всегда:                       vehicleRequests.status + область заявки
 * предпросмотр И боевой вызов:  + waybills.read  — кроме арендодательской ветви (Р16)
 * исход `crew`:                 + waybills.correct
 *   └─ и глубже 30 дней:        + waybills.correctBeyondLimit
 * ```
 *
 * `vehicleRequests.status` — то же право, которым заказ закрывают сегодня: закрытие это решение о
 * ходе заявки, а не правка заказа. `waybills.read` стражем маршрута **не объявляется** и объявлено
 * быть не может: предпросмотр называет номера бланков, а арендодатель, у которого права на журнал
 * листов нет и не будет, закрывает свой заказ этой же дверью (Р16). Поэтому в реестре доступа у
 * обоих маршрутов вид `effectConditionalPermissions` — «базовое право плюс `waybills.read`, когда
 * ветвь команды не `paperlessLessorCompletion`», — а спрашивает его сама дверь, в трёх местах:
 * здесь на предпросмотре (после расчёта ветви и **до** сборки DTO), в `authorize` боевой команды и
 * в `authorizeRepeat`, куда повтор по ключу приходит мимо `plan` и `authorize`.
 *
 * Коррекционные права в реестр не попадают по той же причине, что у соседей: исход считается под
 * блокировкой (Р8, Р32 плана периодов) — закрытие сегодняшним днём коррекции не требует, а
 * закрытие задним числом или гашение отработанной группы требует, — и из тела он не виден.
 */

const idParams = z.object({ id: uuidSchema });

/**
 * Ответ боевой ручки: состояние заявки после команды, а не отчёт о ней (Р9 плана периодов).
 *
 * Пересобирается из **текущего** состояния, поэтому повтор по ключу отвечает то же, что ответил бы
 * обычный запрос: на повторе предметных мутаций не происходит вовсе, и «что сгорело» с «что снято»
 * приходят пустыми — но срок, статус и снимок закрытия читаются из базы и совпадают с первым
 * ответом.
 */
export interface CompletionResultDto {
  version: number;
  /** true — операцию уже выполнял этот же ключ: работы не было, версия не тронута. */
  repeated: boolean;
  /** Статус, каким он стал. */
  status: RequestStatus;
  /** Срок, каким он стал: у обычного закрытия конец равен фактической дате. */
  dateFrom: string;
  dateTo: string | null;
  /** Снимок закрытия: «закрыли» и «было». Оба пусты у арендодательской ветви (Р16). */
  endedOn: string | null;
  previousDateTo: string | null;
  /** Что переписала сверка: сгоревшие, выписанные и сокращённые номера. */
  esm2: { cancelled: string[]; issued: string[]; trimmed: string[] };
  /** Снят ли ожидавший визы запрос на досрочное завершение (ADR 0044). */
  earlyEndDropped: boolean;
  /** Дни, часы за которые закрытие удалило (Р10). */
  clearedShiftDays: string[];
  /** Дни линейного заказа, снятые с рейсов (Р11, Р27). */
  detachedDays: LinearDayRef[];
  /** Ключ операции журнала; `null` — исход `none`, объяснять нечего. */
  operationId: string | null;
}

/**
 * Заявка видима этой учётке и закрываема ею.
 *
 * Область спрашивается **до** канонической транзакции и по тем же правилам, что у статусной ручки,
 * которую эта дверь заменяет: объектная и отдельская роли работают со своим, арендодатель — со
 * своей техникой, а коридор переходов проверяется правом на ход заявки. Внутрь канона это не
 * переносится: там уже держатся блокировки, и отказ по области означал бы взятые и тут же
 * отпущенные строки.
 *
 * `assertLessorScope` здесь не выбирает ветвь — он **ограничивает область**: арендодатель работает
 * только с заявками, на которые вышла его техника. Ветвь считает дверь (Р16), и по другому
 * признаку: администратор и диспетчер сюда проходят без ограничений, а закрывают по-обычному.
 */
async function assertClosable(p: Principal, requestId: string): Promise<RequestStatus> {
  const [row] = await db
    .select({
      objectId: vehicleRequests.objectId,
      departmentId: vehicleRequests.departmentId,
      status: vehicleRequests.status,
      deletedAt: vehicleRequests.deletedAt,
      lessorId: vehicles.lessorId,
    })
    .from(vehicleRequests)
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .leftJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .where(eq(vehicleRequests.id, requestId));
  if (!row || row.deletedAt) throw err.notFound('Заявка не найдена');
  assertRequestScope(p, row);
  assertLessorScope(p, row.lessorId);
  /*
   * Коридор тот же, что у статусной ручки: «Выполнена» из «В работе» открыта правом хода заявки, а
   * у внешнего исполнителя — его собственным коридором (ADR 0038). Вторая редакция этого правила
   * здесь означала бы, что закрытие фактом доступно тому, кому закрытие статусом не доступно.
   *
   * Спрашивается он у **живой** заявки. У закрытой хода «Выполнена» → «Выполнена» нет по
   * определению, и спроси мы его — недостижим стал бы канонический повтор по ключу (шаг 2): он и
   * приходит на уже закрытую заявку, после обрыва связи. Что делать с таким запросом, решает
   * канон, и решает строже: тот же ключ и тот же автор — прежний результат **с перепроверкой прав
   * по сохранённому снимку** (Р9, Р22), чужой ключ — отказ журнала, тела без ключа — 409 по
   * версии, поднятой первым вызовом (Р25).
   */
  if (row.status !== 'done') assertTransitionAllowed(p, row.status, 'done', 'vehicle');
  return row.status;
}

/** Состояние заявки после команды: срок, статус и снимок закрытия — одним чтением. */
async function readCompletionState(requestId: string): Promise<{
  status: RequestStatus;
  dateFrom: string;
  dateTo: string | null;
  endedOn: string | null;
  previousDateTo: string | null;
}> {
  const [row] = await db
    .select({
      status: vehicleRequests.status,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
      endedOn: vehicleRequestCompletions.endedOn,
      previousDateTo: vehicleRequestCompletions.previousDateTo,
    })
    .from(vehicleRequests)
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .leftJoin(
      vehicleRequestCompletions,
      eq(vehicleRequestCompletions.requestId, vehicleRequests.id),
    )
    .where(eq(vehicleRequests.id, requestId));
  if (!row || row.dateFrom === null) throw err.notFound('Заявка не найдена');
  return {
    status: row.status,
    dateFrom: row.dateFrom,
    dateTo: row.dateTo,
    endedOn: row.endedOn,
    previousDateTo: row.previousDateTo,
  };
}

export default async function vehicleRequestCompletionRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  /*
   * Страж у обоих входов один и тот же и один-единственный: право на ход заявки. Право на бумагу
   * условное и спрашивается дверью (Р22) — объяви мы его здесь, арендодатель потерял бы свой
   * коридор, а он у него единственный.
   */
  const guards = [app.authenticate, app.requirePermission('vehicleRequests.status')];

  /**
   * Предпросмотр закрытия — расчёт без единой записи (Р20 плана периодов).
   *
   * Показывает то, ради чего у закрытия вообще появилось рукопожатие: сам факт (чем закрываем),
   * бумагу, которая сгорит, выпишется и сократится, решения истории, которые погаснут, часы,
   * которые исчезнут, и дни, которые уйдут из рейсов. Расчёт — тот же колбэк, что у боя: вторая
   * копия правил разошлась бы с первой на первом же новом поле, и окно начало бы обещать не то.
   *
   * Рукопожатий тело предпросмотра не описывает вовсе (Р28, первая граница): подтверждать ему
   * нечего — он последствия и вычисляет, — и присланный отпечаток кончается 400 схемы.
   */
  r.post(
    '/:id/completion/preview',
    { preHandler: guards, schema: { params: idParams, body: completionPreviewSchema } },
    async (req): Promise<CompletionPreviewDto> => {
      const p = requirePrincipal(req);
      await assertClosable(p, req.params.id);
      const preview = await previewAssignmentCommand<CompletionPlan>(db, {
        requestId: req.params.id,
        actor: { id: p.id },
        asOf: completionAsOf(),
        plan: (ctx) => planCompletionCommand(ctx, req.body, p),
      });
      /*
       * Право на бумагу — **после** расчёта ветви и **до** сборки ответа (Р22). Порядок здесь не
       * стилистика: DTO называет номера бланков, и спрошенное после сборки право проверяло бы
       * доступ к тому, что уже собрано. Раньше расчёта спросить его тоже нельзя — ветвь считает
       * сервер по субъекту и назначенной машине, а не по телу.
       */
      assertCompletionPaperAccess(p, preview.plan.branch);
      return completionPreviewDto(preview.effects, preview.plan, preview.fingerprint, preview.asOf);
    },
  );

  /**
   * Закрытие заказа фактической датой.
   *
   * Порядок транзакции целиком принадлежит канону (`runAssignmentCommand`, §8 плана периодов): гейт
   * режима, блокировки, повторный поиск операции, версия, расчёт, сверка отпечатка, рукопожатия,
   * условная авторизация, строка журнала коррекций, предметные мутации, бумага с днями и
   * заморозкой, снимок операции, аудит и версия заявки. Дверь заполняет предметные места и ни
   * одного из них не переставляет.
   */
  r.post(
    '/:id/completion',
    { preHandler: guards, schema: { params: idParams, body: completionApplySchema } },
    async (req): Promise<CompletionResultDto> => {
      const p = requirePrincipal(req);
      const requestId = req.params.id;
      await assertClosable(p, requestId);

      const outcome = await runAssignmentCommand<
        CompletionPlan,
        CompletionApplied,
        CompletionPaper
      >(
        db,
        completionCommandSpec({ requestId, actor: p, input: req.body, asOf: completionAsOf() }),
      );

      const state = await readCompletionState(requestId);
      return {
        version: outcome.version,
        repeated: outcome.repeated,
        status: state.status,
        dateFrom: state.dateFrom,
        dateTo: state.dateTo,
        endedOn: state.endedOn,
        previousDateTo: state.previousDateTo,
        esm2: outcome.paper?.esm2 ?? { cancelled: [], issued: [], trimmed: [] },
        earlyEndDropped: outcome.paper?.earlyEndDropped ?? false,
        clearedShiftDays: outcome.applied?.clearedShiftDates ?? [],
        detachedDays: outcome.paper?.detached ?? [],
        operationId: outcome.operation?.operationId ?? null,
      };
    },
  );
}
