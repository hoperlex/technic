import dayjs from 'dayjs';
import type { DriverPreviousReading, ReportItemDto } from '@technic/contracts';

/*
 * Pure input helpers of the staff reading form (`IntakeReadingForm.tsx`), apart from it by size
 * alone: together they exceed the 400-line quality budget (`scripts/quality.mjs`).
 */

/**
 * Предыдущий снимок счётчиков — тот, **с которым сравнивал сервер**.
 *
 * В кабинете он приходит в задании (`DriverAssignmentEntry.previous`) и есть всегда; в отчёте дня
 * его нет — `ReportItemDto` предшественника не несёт. Известен он ровно там, где сервер уже нашёл
 * аномалию: тогда в ответе лежит и значение, и его дата. Этого хватает на подсказку под полем и на
 * предупреждение о приросте там, где прирост уже вызвал вопросы.
 *
 * Где сравнения не было, остаются абсолютные границы — и это не потеря: суточный порог сервер
 * применит сам при записи, а портальные пороги предупреждают, а не решают (см. `readingLimits`).
 */
export function previousOf(item: ReportItemDto, reportDate: string): DriverPreviousReading | null {
  const odometer = item.reading?.odometerAnomaly ?? null;
  const engineHours = item.reading?.engineHoursAnomaly ?? null;
  const measuredOn = odometer?.previousDate ?? engineHours?.previousDate ?? null;
  if (!measuredOn) return null;
  return {
    odometerKm: odometer?.previousValue ?? null,
    engineHours: engineHours?.previousValue ?? null,
    measuredOn,
    // Расстояние до предшественника масштабирует порог. Отрицательным оно не бывает: снимок
    // прошлого дня не может оказаться позже своего.
    daysAgo: Math.max(0, dayjs(reportDate).diff(dayjs(measuredOn), 'day')),
  };
}

/**
 * Запятая нормализуется в точку прямо на вводе: десятичный разделитель зависит от раскладки, и
 * отказывать за него нельзя. Целое поле отбрасывает дробную часть, а не склеивает её с целой:
 * «145 320,7» без разделителя стало бы «1453207» — молча выросшим в десять раз пробегом.
 */
export function normalizeDecimal(raw: string, integer: boolean): string {
  const cleaned = raw.replace(/\s/gu, '').replace(',', '.');
  if (!integer) return cleaned.replace(/[^\d.]/gu, '');
  return cleaned.split('.')[0]!.replace(/\D/gu, '');
}
