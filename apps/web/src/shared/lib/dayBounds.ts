import dayjs from 'dayjs';
import { MOSCOW_TZ } from '@shared/config';

/**
 * Границы дня моментами: фильтр периода спрашивают сутками, а хранятся отметки со временем.
 *
 * Считаются в часовом поясе портала (МСК), а не в поясе браузера: «по 20 августа» должно означать
 * одно и то же на ноутбуке в Москве и на телефоне в командировке — иначе граница уезжает на часы,
 * и последний день периода теряет свои заявки.
 */
export const dayStart = (date: string | undefined): string | undefined =>
  date ? dayjs.tz(date, MOSCOW_TZ).startOf('day').toISOString() : undefined;

export const dayEnd = (date: string | undefined): string | undefined =>
  date ? dayjs.tz(date, MOSCOW_TZ).endOf('day').toISOString() : undefined;
