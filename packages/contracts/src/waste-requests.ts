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
  deliveryFrom: z.coerce.date().optional(),
  deliveryTo: z.coerce.date().optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const volumeSchema = z.coerce.number().int().min(MIN_WASTE_VOLUME_M3);

/**
 * Поля заявки зависят от типа операции:
 *  - container_install → containerTypeId (тип из справочника);
 *  - container_replace → containerId (конкретный контейнер объекта);
 *  - waste_removal     → machineTypeId + volumeM3.
 * Кросс-полевые требования проверяет superRefine.
 */
export const createWasteRequestSchema = z
  .object({
    objectId: uuidSchema,
    requestType: requestTypeSchema,
    containerTypeId: uuidSchema.optional(),
    containerId: uuidSchema.optional(),
    machineTypeId: uuidSchema.optional(),
    volumeM3: volumeSchema.optional(),
    deliveryAt: z.coerce.date(),
    comment: z.string().trim().max(2000).optional().default(''),
    fileIds: z.array(uuidSchema).max(20).optional().default([]),
  })
  .superRefine((v, ctx) => {
    if (v.requestType === 'container_install' && !v.containerTypeId) {
      ctx.addIssue({ code: 'custom', path: ['containerTypeId'], message: 'Выберите тип контейнера' });
    }
    if (v.requestType === 'container_replace' && !v.containerId) {
      ctx.addIssue({ code: 'custom', path: ['containerId'], message: 'Выберите контейнер' });
    }
    if (v.requestType === 'waste_removal') {
      if (!v.machineTypeId) {
        ctx.addIssue({ code: 'custom', path: ['machineTypeId'], message: 'Выберите тип машины' });
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
  containerId: uuidSchema.nullable().optional(),
  machineTypeId: uuidSchema.nullable().optional(),
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
  objectId: string;
  objectCode: string;
  objectName: string;
  requestType: RequestType;
  // container_install / container_replace
  containerTypeId: string | null;
  containerTypeName: string | null;
  containerId: string | null;
  containerLabel: string | null;
  // waste_removal
  machineTypeId: string | null;
  machineTypeName: string | null;
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
