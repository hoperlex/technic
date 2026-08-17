import type { DriverReportDto, VehicleReadingDto } from '@technic/contracts';
import { vehicleReadingsApi } from '@entities/vehicle-reading';
import { useIntakeAction } from './intakeAction';

/**
 * Подтверждение аномалии счётчика (ADR 0103, решение 6; план «Показания техники», §7).
 *
 * **Своей ручки у подтверждения нет, и портал её не выдумывает.** На сервере оно живёт полем тела
 * отправки — `confirmOdometerAnomaly` / `confirmEngineHoursAnomaly` (`reportItemSubmitSchema`), —
 * а ставится после перестройки цепочки той же транзакцией (`confirmAnomalies`). Поэтому портал
 * подтверждает тем же `submit`, что и вносит числа: отправляет строку **с теми же значениями** и
 * поднятым признаком нужного счётчика.
 *
 * Три следствия, ради которых это отдельный модуль, а не три строки в разметке строки состава.
 *
 * 1. **Числа отправляются прежние, до последнего знака.** Сервер сравнивает присланное с
 *    сохранённым и, не найдя разницы, не пишет ни правки, ни истории — подпись при этом ставится
 *    всё равно. Подмени портал хоть комментарий, и подтверждение аномалии стало бы правкой чужого
 *    показания.
 * 2. **Причины у подтверждения нет.** Её требует сервис там, где правят уже сданное число; здесь
 *    число не правят, и пустая причина — правда, а не обход проверки.
 * 3. **Счётчики подтверждаются поодиночке.** Одометр мог быть сброшен, а моточасы прыгнуть: это
 *    разные вопросы к человеку, и общая кнопка подписала бы оба разом. Снять подпись отправкой
 *    нельзя — сервер только ставит её; снимает её пересчёт цепочки, когда концы интервала
 *    разошлись.
 */

/** Какой счётчик подтверждают: у строки их два, и подпись у каждого своя. */
export type AnomalyCounter = 'odometer' | 'engineHours';

export interface AnomalyConfirmVars {
  itemId: string;
  /** Показание строки целиком: из него уходят обратно те же числа, что сервер уже хранит. */
  reading: VehicleReadingDto;
  counter: AnomalyCounter;
}

const CONFLICT =
  'Аномалия не подтверждена: отчёт изменился, пока карточка была открыта. Она перечитана — ' +
  'посмотрите, что стало другим, и подтвердите заново';

export function useAnomalyConfirm(report: DriverReportDto) {
  const action = useIntakeAction({
    run: ({ itemId, reading, counter }: AnomalyConfirmVars) =>
      vehicleReadingsApi.submitDay(report.personId, report.reportDate, {
        // Версия шапки, которую видел подтверждающий: подпись под аномалией — тоже подтверждение
        // данных, а не факта нажатия.
        version: report.version,
        items: [
          {
            itemId,
            reading: {
              kind: 'values',
              odometerKm: reading.odometerKm,
              engineHours: reading.engineHours,
              fuelFilledLiters: reading.fuelFilledLiters,
              comment: reading.comment,
            },
            confirmOdometerAnomaly: counter === 'odometer',
            confirmEngineHoursAnomaly: counter === 'engineHours',
          },
        ],
      }),
    done: 'Аномалия подтверждена',
    conflict: CONFLICT,
  });

  return { confirm: action.mutate, pending: action.isPending };
}
