import dayjs, { type Dayjs } from 'dayjs';
import {
  type AssignVehicleBody,
  type ConfirmScheduleBody,
  type CorrectAssignmentBody,
  normalizeTimeInput,
  RELOCATION_COMMUNICATION_KIND,
  type VehicleRequestDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { trailerTripBody } from './TrailerFields';

/**
 * Тело команды назначения и фактический срок — то, что окно подбора техники отправляет наружу.
 *
 * Отдельным файлом от самого окна по той же границе, что `machinistCommand` отделён от окна
 * машиниста: окно — это состояние формы (ветки принадлежности, подстановки, сброс полей при смене
 * заявки), а здесь правила разговора с дверью. Тело собирается **один раз**: им же спрашивают
 * предпросмотр последствий и его же отправляют подтверждением, и вторая сборка разошлась бы с
 * первой на первом же новом поле — а вместе с ней разошёлся бы отпечаток, которым сервер сверяет
 * обещанное человеку.
 *
 * Поля формы описаны здесь же: их имена знают и сборка тела, и само окно, и разъехаться им
 * нельзя — незнакомое сборке поле молча не уедет на сервер.
 */

/** Значение селекта «завести новый рейс»: пустая строка неотличима от «ещё не выбрали». */
export const NEW_ROUTE = 'new';

export interface AssignFormValues {
  // ── Фактический срок ──
  /** Спецтехника: период работ. */
  dateFrom?: Dayjs | null;
  dateTo?: Dayjs | null;
  /** Грузоперевозка: дата подачи и время («чч:мм»); пустое время — подача без точного часа. */
  scheduledDate?: Dayjs | null;
  scheduledTime?: string;
  lessorId?: string;
  vehicleId?: string;
  pricePerHour?: number | null;
  pricePerShift?: number | null;
  shiftHours?: number | null;
  // ── Маршрут: готовый рейс (в нём меняют разве что водителя) либо новый целиком ──
  routeId?: string;
  /**
   * За рулём рейса. У нового рейса обязателен — рейса без человека не бывает; у готового поле
   * отвечает на другой вопрос, «менять ли того, кто уже за рулём», и пустое значение там
   * законный ответ «не менять» (ADR 0048).
   */
  driverPersonId?: string;
  withTrailer?: boolean;
  trailer1Model?: string;
  trailer1RegNumber?: string;
  trailer2Model?: string;
  trailer2RegNumber?: string;
  garageNumber?: string;
  communicationKind?: string;
  transportationKind?: string;
  /**
   * Машинист заказа техники на объект: на него выписываются недельные листы ЭСМ-2 (миграция
   * 0087). Отдельное поле, а не `driverPersonId`: тот — водитель рейса грузоперевозки, отобранный
   * по документам и категории под машину, а здесь годится любой водитель справочника.
   */
  machinistId?: string;
  // ── Коррекция задним числом (ADR 0101, Р8): только при смене машины у работающей заявки ──
  /** Машину меняют не «с сегодня», а потому, что записана не та: работал другой номер. */
  correctionEnabled?: boolean;
  correctionReason?: string;
  /** Листы ЭСМ-2 отработанных недель, которые переоформить: адресно, а не «все прошлые». */
  unlockWaybillIds?: string[];
  // ── Доставка техники на объект: перегон по желанию (миграция 0082) ──
  /** Спецтехника едет на площадку своим ходом — на эту поездку выписывается 4-П. */
  deliveryEnabled?: boolean;
  deliveryDate?: Dayjs | null;
  deliveryDriverId?: string;
  deliveryFrom?: string;
  deliveryTo?: string;
}

/** Что окно отправляет наружу: собирается один раз и уходит сразу либо после подтверждения. */
export interface AssignCommand {
  assignment: AssignVehicleBody;
  schedule: ConfirmScheduleBody | null;
  correction?: CorrectAssignmentBody;
  previewFingerprint?: string;
}

/**
 * Фактический срок в том виде, в каком его принимает API. Время подачи собирается по МСК — в этом
 * поясе живут и заявка, и путевой лист; пустое время означает подачу «на дату», как и при
 * заведении заявки.
 */
export function assignScheduleOf(
  request: VehicleRequestDto | null,
  v: AssignFormValues,
): ConfirmScheduleBody | null {
  if (!request) return null;
  if (request.requestType === 'special_equipment') {
    if (!v.dateFrom) return null;
    return {
      requestType: 'special_equipment',
      dateFrom: v.dateFrom.format('YYYY-MM-DD'),
      dateTo: v.dateTo ? v.dateTo.format('YYYY-MM-DD') : null,
    };
  }
  if (!v.scheduledDate) return null;
  const time = normalizeTimeInput(v.scheduledTime ?? '');
  return {
    requestType: 'freight_transport',
    scheduledAt: dayjs
      .tz(`${v.scheduledDate.format('YYYY-MM-DD')} ${time ?? '00:00'}`, MOSCOW_TZ)
      .format('YYYY-MM-DDTHH:mm:ssZ'),
    scheduledTimeUnspecified: time === undefined,
  };
}

interface CommandContext {
  schedule: ConfirmScheduleBody | null;
  /** Спрашивался ли машинист ЭСМ-2 — от этого зависит, уходит ли поле вовсе. */
  needsMachinist: boolean;
  /** Ведётся ли рейс: у аренды и у заказа техники на объект его не бывает (ADR 0041). */
  needsRoute: boolean;
  /** Заведён ли перегон на объект (миграция 0082). */
  wantsDelivery: boolean;
  /** Ключ операции коррекции задним числом; `null` — обычная смена, без правки прошлого. */
  correctionId: string | null;
}

/** Команда назначения целиком: машина, ставки, человек, рейс, перегон и признак коррекции. */
export function assignCommandBody(v: AssignFormValues, ctx: CommandContext): AssignCommand {
  return {
    assignment: {
      vehicleId: v.vehicleId!,
      pricePerHour: v.pricePerHour ?? null,
      pricePerShift: v.pricePerShift ?? null,
      shiftHours: v.shiftHours ?? null,
      // Машинист заказа техники на объект: на него выписываются листы ЭСМ-2 за каждую неделю
      // срока. У грузоперевозки поля нет — там водитель принадлежит рейсу. У линейной заявки
      // поле уходит пустым, если его не заполнили: назначение без машиниста законно, листы по
      // ней выписывают отдельно и своим человеком (ADR 0100 решение 6).
      //
      // Незаполненное поле уезжает не пустой строкой и не `null`, а отсутствием ключа:
      // `undefined` теряется при сериализации тела, и сервер получает ровно то, что описано
      // контрактом, — «машиниста не называли». При смене техники (ADR 0048) это и есть
      // «оставить прежнего»: сверка ЭСМ-2 возьмёт человека с прежнего листа заявки.
      ...(ctx.needsMachinist ? { driverPersonId: v.machinistId } : {}),
      // Рейс: готовый — идентификатором и, если человека выбрали, новым водителем; новый —
      // вместе с водителем и реквизитами выезда.
      ...(ctx.needsRoute
        ? {
            route:
              v.routeId && v.routeId !== NEW_ROUTE
                ? {
                    routeId: v.routeId,
                    // Ключ уходит только с выбранным именем. Отсутствие ключа контракт читает
                    // как «водителя не трогать» (ADR 0048), и это единственное, чем окно может
                    // выразить пустое поле: `null` там означает «снять», а рейс общий — снятие
                    // оставило бы без водителя и чужие заявки. Такое решение принимают правкой
                    // маршрута, где виден весь состав (ADR 0082), — здесь его не предлагают.
                    ...(v.driverPersonId ? { driverPersonId: v.driverPersonId } : {}),
                  }
                : {
                    newRoute: {
                      driverPersonId: v.driverPersonId,
                      trip: {
                        ...trailerTripBody(v),
                        garageNumber: v.garageNumber ?? '',
                        communicationKind: v.communicationKind ?? '',
                        transportationKind: v.transportationKind ?? '',
                      },
                    },
                  },
          }
        : {}),
      // Доставка техники на объект — отдельный рейс на дату перегона, а не часть маршрута
      // заявки: у спецтехники маршрута нет вовсе, есть период работы машины на площадке.
      ...(ctx.wantsDelivery
        ? {
            delivery: {
              routeDate: v.deliveryDate!.format('YYYY-MM-DD'),
              driverPersonId: v.deliveryDriverId,
              moveFrom: v.deliveryFrom!.trim(),
              moveTo: v.deliveryTo!.trim(),
              // Вид сообщения перегона портал ставит сам — окно про него не спрашивает
              // (`RELOCATION_COMMUNICATION_KIND`): технику везут с базы на площадку по городу.
              trip: { communicationKind: RELOCATION_COMMUNICATION_KIND },
            },
          }
        : {}),
    },
    schedule: ctx.schedule,
    // Признак коррекции уходит отдельным блоком, а не полем назначения: он не о том, чем заявку
    // выполняют, а о том, что запрос утверждает про прошедшие дни (ADR 0101, Р8).
    ...(ctx.correctionId
      ? {
          correction: {
            operationId: ctx.correctionId,
            reason: v.correctionReason!.trim(),
            unlockWaybillIds: v.unlockWaybillIds ?? [],
          },
        }
      : {}),
  };
}
