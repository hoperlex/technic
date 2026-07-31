import { z } from 'zod';
import { baseListQuery, uuidSchema } from './common';

/**
 * Справочник отделов (ADR 0040) — офисные подразделения: снабжение, ПТО, АХО. Устроен как
 * справочник объектов строительства, потому что отвечает на тот же вопрос с другой стороны:
 * от чьего имени заводится заявка. Пересечения с объектами у отделов нет.
 */
export const DEPARTMENT_SORT_FIELDS = ['code', 'name', 'isActive', 'createdAt'] as const;

/**
 * Руководители отдела — учётки с ролью «Руководитель отдела», привязанные к отделу. Передаются
 * полным списком: сервер синхронизирует набор, как операторов у объекта. Отдельного хранилища у
 * этой связи нет — она и есть привязка учётки к отделу, показанная со стороны справочника.
 */
export const headUserIdsSchema = z.array(uuidSchema).max(50);

export const departmentListQuerySchema = baseListQuery(DEPARTMENT_SORT_FIELDS).extend({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export const createDepartmentSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  isActive: z.boolean().default(true),
  headUserIds: headUserIdsSchema.optional().default([]),
});
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

// `.partial()` снимает обязательность, но не `.default()` (тот же подвох, что в updateObjectSchema),
// поэтому поля со значением по умолчанию объявлены заново: PATCH без `headUserIds` иначе снимал
// бы всех руководителей отдела.
export const updateDepartmentSchema = createDepartmentSchema.partial().extend({
  isActive: z.boolean().optional(),
  /** Полный список руководителей; отсутствие поля — не трогать привязки. */
  headUserIds: headUserIdsSchema.optional(),
});
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;

/** Руководитель в карточке отдела: столько, сколько нужно для показа и повторного выбора. */
export interface DepartmentHeadRefDto {
  id: string;
  fullName: string;
}

export interface DepartmentDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  /** Руководители отдела (ADR 0040); порядок — по ФИО. */
  heads: DepartmentHeadRefDto[];
  createdAt: string;
  updatedAt: string;
}
