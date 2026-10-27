import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  dateOnlySchema,
  DRIVER_ASSIGNMENT_FUTURE_DAYS,
  DRIVER_ASSIGNMENT_PAST_DAYS,
  DRIVER_DRAFT_FORMAT,
  DRIVER_DRAFT_FORMAT_HEADER,
  DRIVER_SUBMIT_PAST_DAYS,
  moscowDateKeyOf,
  reportSubmitSchema,
} from '@technic/contracts';
import { err } from '../lib/errors';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { buildAssignment } from '../services/driver-assignment';
import {
  driverClientOutdated,
  LEGACY_DRIVER_DRAFT_FORMAT,
  loadReport,
  openReport,
  submitReport,
} from '../services/readings';

/**
 * Кабинет водителя (ADR 0102) — второй контур портала: своё задание на дату и свои показания.
 *
 * Два свойства этих маршрутов важнее всего остального в файле.
 *
 * **`personId` здесь не принимается ни в каком виде** — ни в пути, ни в теле, ни в фильтре. Это и
 * есть четвёртая ось области видимости: она держится не предикатом, который можно забыть вызвать,
 * а отсутствием параметра, который нечего проверять. Человек берётся из принципала, и другого
 * способа его назвать у клиента нет.
 *
 * **Ответы самодостаточны.** У роли `driver` нет `directories.read`, поэтому справочники кабинету
 * не отдаются, а все подписи — машины, рейса, заказчика — собирает сервер. Идентификаторов
 * справочных записей в ответах этих ручек быть не должно.
 */

const dateParams = z.object({ date: dateOnlySchema });

/**
 * Человек принципала. У роли `driver` он обязателен по построению (CHECK `users_driver_person_check`
 * плюс проверка живости в `loadPrincipal`), но ручки кабинета открыты и тому, кому право выдали
 * иначе, — отказ здесь внятный, а не падение на `null` в запросе.
 */
function personOf(p: Principal): string {
  if (!p.personId) {
    throw err.forbidden('Учётная запись не связана с карточкой работника');
  }
  return p.personId;
}

/**
 * Окно чтения шире окна записи (ADR 0102): читать задание можно за месяц назад и две недели
 * вперёд, а сдавать показания — только за прошедшую неделю плюс сегодня. Одно окно на оба
 * действия отдавало бы водителю возможность закрыть будущий рейс, которого ещё не было.
 */
function assertReadWindow(date: string, today: string): void {
  const from = shiftDays(today, -DRIVER_ASSIGNMENT_PAST_DAYS);
  const to = shiftDays(today, DRIVER_ASSIGNMENT_FUTURE_DAYS);
  if (date < from || date > to) throw err.badRequest('Дата вне доступного окна');
}

function canSubmitOn(date: string, today: string): boolean {
  return date >= shiftDays(today, -DRIVER_SUBMIT_PAST_DAYS) && date <= today;
}

function shiftDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  return shifted.toISOString().slice(0, 10);
}

/** Сегодня по МСК: день кабинета — тот же день, что у рейса и у листа. */
function todayKey(): string {
  return moscowDateKeyOf(new Date());
}

/**
 * Ключ идемпотентности отправки (ADR 0103): портал генерирует его на открытие оверлея и держит
 * вместе с черновиком. Отсутствие ключа — не ошибка: повтор без него просто не будет распознан как
 * повтор, и отправка пойдёт обычной оптимистической блокировкой по версии.
 */
function idempotencyKeyOf(req: FastifyRequest): string | null {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw err.badRequest('Некорректный Idempotency-Key');
  return parsed.data;
}

/** The draft format the build declared, `null` when it declared none. */
function draftFormatOf(req: FastifyRequest): string | null {
  const raw = req.headers[DRIVER_DRAFT_FORMAT_HEADER];
  return (Array.isArray(raw) ? raw[0] : raw) ?? null;
}

/**
 * Граница, после которой старый формат черновика больше не рождается (ADR 0129, решение 8; план
 * `docs/driver-readings-first-plan.md`, Р13).
 *
 * Черновик кабинета адресуется идентификаторами строк ожидания, а те приходят только из открытия
 * отчёта: без него у формы нет ни одного блока и записывать нечего. Значит запрет ставится ровно
 * здесь — на открытии, а не на чтении задания и не на отправке. Читать старому клиенту по-прежнему
 * можно: показания, уже переданные с него, никуда не деваются, и отбирать у водителя вид на свой
 * день из-за версии сборки было бы наказанием не по делу.
 *
 * Гарантии сохранности запрет не даёт и дать не может: форма, открытая до выката, пишет черновик
 * локально и без сети — снаружи это не остановить ничем. Он лишь прекращает поток **новых** записей
 * старого формата и делает устаревание громким; сохранность держит показ несопоставленной записи на
 * стороне портала.
 */
function assertDraftFormat(req: FastifyRequest): string {
  const declared = draftFormatOf(req);
  // Сравнение точное: отсутствие заголовка и незнакомое значение — один и тот же случай «клиент не
  // договаривался с этим сервером о формате», и разных исходов у них нет. The legacy `v2` passes
  // here only to reach the service, which lets it reopen a `v2` report and nothing else.
  if (declared !== DRIVER_DRAFT_FORMAT && declared !== LEGACY_DRIVER_DRAFT_FORMAT) {
    throw driverClientOutdated();
  }
  return declared;
}

export default async function driverRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: [app.authenticate, app.requirePermission('driverCabinet.read')] };
  const submit = { preHandler: [app.authenticate, app.requirePermission('driverCabinet.submit')] };

  /** Задание на дату. Пустой список — законное состояние экрана, а не 404. */
  r.get(
    '/assignment',
    { ...read, schema: { querystring: z.object({ date: dateOnlySchema.optional() }) } },
    async (req) => {
      const p = requirePrincipal(req);
      const today = todayKey();
      const date = req.query.date ?? today;
      assertReadWindow(date, today);
      return buildAssignment(personOf(p), date, canSubmitOn(date, today));
    },
  );

  /**
   * Открытие отчёта дня: заводит черновик и строки ожидания и возвращает их идентификаторы.
   *
   * Отдельным действием, а не побочным эффектом чтения задания: до открытия писать некуда, а
   * открытие заводит строки — то есть занимает источники глобально (ADR 0103). Чтение задания
   * такого права не имеет и остаётся безобидным.
   *
   * The only door that REQUIRES a declared draft format (`assertDraftFormat`): the ids the draft
   * is addressed by are born here. A new report needs the current `v3` build; a legacy `v2` build may
   * only reopen a report that is itself `v2`, so that a report opened before the release can finish.
   * A `v3` open of an untouched `v2` draft upgrades it (`openReport`); the submit door checks the
   * stored format.
   */
  r.post('/reports/:date/open', { ...submit, schema: { params: dateParams } }, async (req) => {
    const p = requirePrincipal(req);
    // Формат черновика спрашивается первым: отказ устаревшей сборке не зависит ни от даты, ни от
    // состава дня, и «обновите приложение» полезнее, чем «за этот день уже не передать».
    const clientDraftFormat = assertDraftFormat(req);
    const today = todayKey();
    const { date } = req.params;
    if (!canSubmitOn(date, today)) throw err.badRequest('За этот день показания уже не передать');
    return openReport(personOf(p), date, p.id, { clientDraftFormat });
  });

  /** Свой отчёт за дату. `null` — ещё не открывали: у экрана это состояние «ничего не передано». */
  r.get('/reports/:date', { ...read, schema: { params: dateParams } }, async (req) => {
    const p = requirePrincipal(req);
    const today = todayKey();
    assertReadWindow(req.params.date, today);
    return loadReport(personOf(p), req.params.date);
  });

  /**
   * Передача показаний. Идемпотентна по паре «ключ + отпечаток тела»: повтор потерянного ответа
   * возвращает текущее состояние, а тот же ключ с другим телом — конфликт, потому что это уже
   * другая команда под старым ключом.
   *
   * The declared draft format is passed through, not checked here: the service compares it with
   * the report's STORED format after the idempotency lookup (ADR 0234). An unconditional `v3` guard
   * at this door would refuse the retry of a submit accepted before the release, and would stop a
   * `v2` report opened before it from ever finishing.
   */
  r.post(
    '/reports/:date/submit',
    { ...submit, schema: { params: dateParams, body: reportSubmitSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const today = todayKey();
      const { date } = req.params;
      if (!canSubmitOn(date, today)) throw err.badRequest('За этот день показания уже не передать');
      return submitReport(personOf(p), date, req.body, p.id, idempotencyKeyOf(req), {
        clientDraftFormat: draftFormatOf(req),
      });
    },
  );
}
