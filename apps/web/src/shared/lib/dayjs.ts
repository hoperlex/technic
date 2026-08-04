import dayjs from 'dayjs';
import 'dayjs/locale/ru';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { MOSCOW_TZ } from '@shared/config';

/**
 * Настройка dayjs на весь портал: часовой пояс и русская локаль.
 *
 * Раньше это делалось побочным эффектом в точке входа, и тесты приходилось настраивать отдельно —
 * два места, которые обязаны совпадать, но связаны только памятью. Теперь настройка вызывается
 * явно: приложением при старте, тестами в их setup.
 */
export function setupDayjs(): void {
  dayjs.extend(utc);
  dayjs.extend(timezone);
  dayjs.locale('ru');
  dayjs.tz.setDefault(MOSCOW_TZ);
}
