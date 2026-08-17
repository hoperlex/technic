import { expect } from 'vitest';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { WAYBILL_ACK_REQUIRED_CODE, type WaybillAckRequiredDetails } from '@technic/contracts';

/**
 * Выписка листа в **подготовке** теста: одним вызовом, с рукопожатием внутри (Р21).
 *
 * Заведён потому, что рукопожатие стоит на каждом пути, выпускающем номер (Р21а), а лист в
 * подавляющем большинстве db-тестов не предмет проверки, а декорация: рейс «с выданной бумагой» —
 * это состояние, в котором тест застаёт заявку, маршрут или журнал. Заставлять каждый такой тест
 * выписывать двухходовку — читать отпечаток из тела отказа и слать второй запрос — значит утопить
 * смысл теста в обвязке: у половины файлов эта обвязка была бы длиннее самой проверки.
 *
 * Дыры Р21 помощник при этом не открывает, потому что и не касается сервера: он проходит ровно
 * тот путь, который проходит окно портала, — первый запрос без подтверждения, 409 со свежим
 * отпечатком, второй с ним. Что рукопожатие вообще спрашивается, что подложный отпечаток
 * отвергается и что на отказе номер бланка не расходуется, проверяется руками — в
 * `waybill-ack.db.test.ts`, где предмет теста как раз оно.
 *
 * Всё, что не 200 и не 409 `waybill_ack_required`, помощник не прячет: подготовка, свалившаяся на
 * 422 или 403, обязана назвать себя телом ответа, а не отдать тесту чужой результат.
 */

/**
 * Приложение глазами помощника: `inject` и ничего больше.
 *
 * Структурным типом, а не `Awaited<ReturnType<typeof buildApp>>`: сборка приложения тянет за собой
 * конфиг, а он читается при импорте и без выставленного окружения падает — db-тесты потому и зовут
 * `await import('../src/app')` уже внутри `beforeAll`. Помощнику от приложения нужна одна ручка, и
 * называть её типом дешевле, чем тащить сюда весь модуль.
 */
export interface InjectingApp {
  inject(options: InjectOptions): Promise<LightMyRequestResponse>;
}

/** Тело команды: `version`, а у задней выписки и коррекции ещё `reason` с ключом операции. */
export type IssuePayload = Record<string, unknown>;

/** Чем кончился вызов. */
export interface AcknowledgedCall {
  /** Ответ **удавшейся** попытки: 200 и тело с выписанным листом. */
  res: LightMyRequestResponse;
  /**
   * Тело, которым лист в итоге выписан, — с подтверждением, если оно потребовалось.
   *
   * Отдаётся наружу ради повтора команды задним числом (Р31): ключ идемпотентности сверяется
   * отпечатком **всего** тела, и повтор без `acknowledge` был бы для сервера другой командой под
   * занятым ключом — то есть 409 `CORRECTION_KEY_REUSED` вместо ожидаемого «ничего не выполнено».
   */
  payload: IssuePayload;
  /** Потребовалось ли рукопожатие: у рейса без предупреждений лист выписывается с первого раза. */
  acknowledged: boolean;
}

/**
 * Сколько раз помощник готов постучаться.
 *
 * Больше двух, потому что перенос заявки подтверждает два листа (Р21а), а сервер называет их по
 * одному — первый неподтверждённый останавливает операцию. Предел вообще есть, потому что набор
 * предупреждений может расходиться с каждым запросом (чужая правка в соседней транзакции), и
 * бесконечный цикл в тесте выглядел бы как зависший прогон, а не как отказ.
 */
const MAX_ATTEMPTS = 4;

/** Тело отказа `waybill_ack_required` или `null`, если ответ не о рукопожатии. */
function ackDetailsOf(res: LightMyRequestResponse): WaybillAckRequiredDetails | null {
  if (res.statusCode !== 409) return null;
  const body = res.json() as { code?: string; details?: WaybillAckRequiredDetails };
  if (body.code !== WAYBILL_ACK_REQUIRED_CODE || !body.details) return null;
  return body.details;
}

/**
 * Общий ход всех путей выпуска номера: запрос, и если сервер попросил подтверждения — тот же
 * запрос с полученным отпечатком.
 *
 * Куда лечь отпечатку, знает вызывающий (`place`): у выписки и коррекции поле одно, у переноса —
 * две половины, и какая из них чья, различает `details.routeId`.
 */
async function postWithAck(options: {
  app: InjectingApp;
  url: string;
  headers: Record<string, string>;
  payload: IssuePayload;
  place: (payload: IssuePayload, details: WaybillAckRequiredDetails) => IssuePayload;
  /**
   * Ждать ли готовую бумагу. По умолчанию да — выписка тут шаг подготовки, и её отказ обязан
   * назваться сам. Но у той же двери проверяют и **настоящие** отказы: день вне срока, чужой
   * статус, арендная машина. Для них помощник нужен ровно затем, чтобы снять с дороги
   * рукопожатие, а ответ вернуть как есть — иначе тест об отказе падал бы на ожидании успеха.
   */
  expectIssued?: boolean;
}): Promise<AcknowledgedCall> {
  let payload = options.payload;
  let acknowledged = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const res = await options.app.inject({
      method: 'POST',
      url: options.url,
      headers: options.headers,
      payload,
    });
    const details = ackDetailsOf(res);
    if (!details) {
      // Не рукопожатие — значит либо готовая бумага, либо настоящий отказ. Второе и есть та самая
      // внятность: сообщение несёт тело ответа, по которому видно, чем подготовка не сошлась.
      if (options.expectIssued !== false) {
        expect(res.statusCode, `${options.url}: ${res.body}`).toBe(200);
      }
      return { res, payload, acknowledged };
    }
    payload = options.place(payload, details);
    acknowledged = true;
  }

  throw new Error(
    `${options.url}: рукопожатие не сошлось за ${MAX_ATTEMPTS} попытки — сервер требует подтверждения снова и снова`,
  );
}

/** Подтверждение одного листа: `acknowledge: { fingerprint }` — форма выписки и коррекции. */
function placeSingle(payload: IssuePayload, details: WaybillAckRequiredDetails): IssuePayload {
  return { ...payload, acknowledge: { fingerprint: details.fingerprint } };
}

// ── Пути выпуска номера (Р21а) ───────────────────────────────────────────────────────────────

/**
 * Обычная и задняя выписка: `POST /vehicle-routes/:id/waybill`.
 *
 * `payload` — целиком тело команды, а не одна версия: задняя выписка несёт ещё причину и ключ
 * операции (ADR 0101), и помощник о них не знает ничего, кроме того, что тащит их насквозь.
 */
export async function issueRouteWaybill(options: {
  app: InjectingApp;
  headers: Record<string, string>;
  routeId: string;
  payload: IssuePayload;
}): Promise<AcknowledgedCall> {
  return postWithAck({
    app: options.app,
    url: `/api/v1/vehicle-routes/${options.routeId}/waybill`,
    headers: options.headers,
    payload: options.payload,
    place: placeSingle,
  });
}

/**
 * Коррекция рейса: `POST /vehicle-routes/:id/correction`. Кончается настоящим бланком, и
 * рукопожатие у неё то же, что у обычной выписки, — по будущему состоянию рейса.
 */
export async function correctRouteWithAck(options: {
  app: InjectingApp;
  headers: Record<string, string>;
  routeId: string;
  payload: IssuePayload;
}): Promise<AcknowledgedCall> {
  return postWithAck({
    app: options.app,
    url: `/api/v1/vehicle-routes/${options.routeId}/correction`,
    headers: options.headers,
    payload: options.payload,
    place: placeSingle,
  });
}

/**
 * Перенос заявки между рейсами: `POST /vehicle-routes/:target/correction/transfer`.
 *
 * Подтверждений здесь два — приёмника и источника, — и приходят они по одному: сервер выписывает
 * листы подряд и останавливается на первом неподтверждённом. Половина выбирается по `routeId` из
 * тела отказа, а не по порядку попыток: опустевшему источнику лист не выписывается вовсе (Р22), и
 * «первый отказ — про приёмник» было бы догадкой, а не правилом.
 */
export async function transferRequestWithAck(options: {
  app: InjectingApp;
  headers: Record<string, string>;
  targetRouteId: string;
  payload: IssuePayload;
}): Promise<AcknowledgedCall> {
  return postWithAck({
    app: options.app,
    url: `/api/v1/vehicle-routes/${options.targetRouteId}/correction/transfer`,
    headers: options.headers,
    payload: options.payload,
    place: (payload, details) => {
      const half = details.routeId === options.targetRouteId ? 'target' : 'source';
      const previous = (payload.acknowledge ?? {}) as Record<string, unknown>;
      return {
        ...payload,
        acknowledge: { ...previous, [half]: { fingerprint: details.fingerprint } },
      };
    },
  });
}

/**
 * ЭСМ-2 по требованию: `POST /vehicle-requests/:id/esm2` — **пятый** путь выпуска номера.
 *
 * Р21а называла четыре; пятый нашёлся сверкой ADR 0108 с кодом. Рейса у ЭСМ-2 нет, поэтому из всех
 * предупреждений применимо одно — пробелы в документах машиниста (ADR 0064), — и отпечаток приходит
 * без `routeId`/`routeNumber`, которых у бланка на заявку не бывает. Форма подтверждения общая:
 * `acknowledge: { fingerprint }`.
 */
export async function issueRequestEsm2(options: {
  app: InjectingApp;
  headers: Record<string, string>;
  requestId: string;
  payload: IssuePayload;
  /** `false` — вернуть ответ как есть: у этой двери проверяют и настоящие отказы. */
  expectIssued?: boolean;
}): Promise<AcknowledgedCall> {
  return postWithAck({
    app: options.app,
    url: `/api/v1/vehicle-requests/${options.requestId}/esm2`,
    headers: options.headers,
    payload: options.payload,
    place: placeSingle,
    expectIssued: options.expectIssued,
  });
}
