import { z } from 'zod';
import { requestStatusSchema, requestTypeSchema } from './enums';
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

export const createWasteRequestSchema = z.object({
  objectId: uuidSchema,
  containerTypeId: uuidSchema,
  requestType: requestTypeSchema,
  deliveryAt: z.coerce.date(),
  comment: z.string().trim().max(2000).optional().default(''),
  fileIds: z.array(uuidSchema).max(20).optional().default([]),
});
export type CreateWasteRequestInput = z.infer<typeof createWasteRequestSchema>;

export const updateWasteRequestSchema = z.object({
  objectId: uuidSchema.optional(),
  containerTypeId: uuidSchema.optional(),
  requestType: requestTypeSchema.optional(),
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
  containerTypeId: string;
  containerTypeName: string;
  requestType: RequestType;
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
