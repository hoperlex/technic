import { z } from 'zod';
import { MIN_WASTE_VOLUME_M3, requestStatusSchema, requestTypeSchema } from './enums';
import type { RequestStatus, RequestType } from './enums';
import { baseListQuery, uuidSchema } from './common';
import type { FileDto } from './files';

export const WASTE_REQUEST_SORT_FIELDS = [
  'objectName',
  'containerTypeName',
  'requestType',
  'deliveryAt',
  'status',
  'createdAt',
] as const;

export const wasteRequestListQuerySchema = baseListQuery(WASTE_REQUEST_SORT_FIELDS).extend({
  status: requestStatusSchema.optional(),
  objectId: uuidSchema.optional(),
  containerTypeId: uuidSchema.optional(),
  requestType: requestTypeSchema.optional(),
  // поиск по сквозному номеру заявки (точное совпадение)
  num: z.coerce.number().int().positive().optional(),
  deliveryFrom: z.coerce.date().optional(),
  deliveryTo: z.coerce.date().optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // вкладка «На объекте»: исключить отменённые заявки
  excludeCancelled: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const volumeSchema = z.coerce.number().int().min(MIN_WASTE_VOLUME_M3);

/**
 * Поля заявки зависят от типа операции:
 *  - container_install → containerTypeId (тип контейнера из справочника, type='cont');
 *  - container_replace → containerTypeId (тип, установленный на этом объекте);
 *  - waste_removal     → containerTypeId (тип машины или контейнера) + volumeM3.
 * Кросс-полевые требования проверяет superRefine.
 */
export const createWasteRequestSchema = z
  .object({
    objectId: uuidSchema,
    requestType: requestTypeSchema,
    containerTypeId: uuidSchema.optional(),
    volumeM3: volumeSchema.optional(),
    deliveryAt: z.coerce.date(),
    comment: z.string().trim().max(2000).optional().default(''),
    fileIds: z.array(uuidSchema).max(20).optional().default([]),
  })
  .superRefine((v, ctx) => {
    if (v.requestType === 'container_install' && !v.containerTypeId) {
      ctx.addIssue({ code: 'custom', path: ['containerTypeId'], message: 'Выберите тип контейнера' });
    }
    if (v.requestType === 'container_replace' && !v.containerTypeId) {
      ctx.addIssue({
        code: 'custom',
        path: ['containerTypeId'],
        message: 'Выберите тип контейнера для замены',
      });
    }
    if (v.requestType === 'waste_removal') {
      if (!v.containerTypeId) {
        ctx.addIssue({
          code: 'custom',
          path: ['containerTypeId'],
          message: 'Выберите тип машины/контейнера',
        });
      }
      if (v.volumeM3 == null) {
        ctx.addIssue({ code: 'custom', path: ['volumeM3'], message: 'Укажите объём' });
      }
    }
  });
export type CreateWasteRequestInput = z.infer<typeof createWasteRequestSchema>;

export const updateWasteRequestSchema = z.object({
  objectId: uuidSchema.optional(),
  requestType: requestTypeSchema.optional(),
  containerTypeId: uuidSchema.nullable().optional(),
  volumeM3: volumeSchema.nullable().optional(),
  deliveryAt: z.coerce.date().optional(),
  comment: z.string().trim().max(2000).optional(),
  addFileIds: z.array(uuidSchema).max(20).optional(),
  removeFileIds: z.array(uuidSchema).optional(),
  version: z.number().int().nonnegative(),
});
export type UpdateWasteRequestInput = z.infer<typeof updateWasteRequestSchema>;

export const changeWasteRequestStatusSchema = z.object({
  status: requestStatusSchema,
  version: z.number().int().nonnegative(),
});
export type ChangeWasteRequestStatusInput = z.infer<typeof changeWasteRequestStatusSchema>;

export interface WasteRequestDto {
  id: string;
  /** Сквозной человекочитаемый номер (отображается как «<num>-<буква типа>»). */
  num: number;
  objectId: string;
  objectCode: string;
  objectName: string;
  requestType: RequestType;
  // container_install / container_replace → тип контейнера; waste_removal → тип машины/контейнера
  containerTypeId: string | null;
  containerTypeName: string | null;
  // waste_removal
  volumeM3: number | null;
  deliveryAt: string;
  comment: string;
  status: RequestStatus;
  files: FileDto[];
  version: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
