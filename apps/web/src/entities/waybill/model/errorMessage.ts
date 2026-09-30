import { errorMessage } from '@shared/lib';

const WAYBILL_ERROR_LABELS: Record<string, string> = {
  reason: 'Причина аннулирования',
  operationId: 'Операция',
  ids: 'Путевые листы',
  addFileIds: 'Файлы',
};

export const waybillErrorMessage = (error: unknown): string => errorMessage(error, WAYBILL_ERROR_LABELS);
