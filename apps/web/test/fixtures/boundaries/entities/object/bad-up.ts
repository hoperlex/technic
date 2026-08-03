/** Запрещено: импорт вверх — entities не знает о features. */
import { listObjects } from '@features/x';

export const objects = listObjects();
