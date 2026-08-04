/** Разрешено точечно: оба вида заявок берут общее из `request` (ADR 0012, ADR 0015). */
import { requestStatus } from '@entities/request';

export const status = requestStatus;
