import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  dateOnlySchema,
  DRIVER_ASSIGNMENT_FUTURE_DAYS,
  DRIVER_ASSIGNMENT_PAST_DAYS,
  DRIVER_SUBMIT_PAST_DAYS,
  moscowDateKeyOf,
  reportSubmitSchema,
} from '@technic/contracts';
import { err } from '../lib/errors';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { buildAssignment } from '../services/driver-assignment';
import { loadReport, openReport, submitReport } from '../services/readings';

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
   */
  r.post('/reports/:date/open', { ...submit, schema: { params: dateParams } }, async (req) => {
    const p = requirePrincipal(req);
    const today = todayKey();
    const { date } = req.params;
    if (!canSubmitOn(date, today)) throw err.badRequest('За этот день показания уже не передать');
    return openReport(personOf(p), date, p.id);
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
   */
  r.post(
    '/reports/:date/submit',
    { ...submit, schema: { params: dateParams, body: reportSubmitSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const today = todayKey();
      const { date } = req.params;
      if (!canSubmitOn(date, today)) throw err.badRequest('За этот день показания уже не передать');
      return submitReport(personOf(p), date, req.body, p.id, idempotencyKeyOf(req));
    },
  );
}
