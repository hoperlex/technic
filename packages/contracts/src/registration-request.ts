import { z } from 'zod';
import type { Role } from './enums';

// ── Пожелание по роли в заявке на регистрацию ──
// Человек выбирает, кем работает; права из этого не следуют (ADR 0034). Роль назначает
// администратор при активации — иначе саморегистрация выдавала бы доступ, а признак «заявка =
// не активна и без роли» перестал бы работать. Поэтому это отдельный перечень, а не `Role`:
// у двух вариантов роли в портале нет вовсе, а называются они на языке заявителя.

export const REGISTRATION_ROLE_REQUESTS = [
  'dispatcher',
  'rukstroy',
  'site_staff',
  'waste_operator',
  'vehicle_lessor',
  'other',
] as const;
export const registrationRoleRequestSchema = z.enum(REGISTRATION_ROLE_REQUESTS);
export type RegistrationRoleRequest = (typeof REGISTRATION_ROLE_REQUESTS)[number];

export const registrationRoleRequestLabels: Record<RegistrationRoleRequest, string> = {
  dispatcher: 'Диспетчер',
  rukstroy: 'Руководитель строительства',
  // «Штаб» — название из таблицы прав; заявителю оно ничего не говорит.
  site_staff: 'Сотрудник объекта',
  waste_operator: 'Оператор по вывозу мусора',
  vehicle_lessor: 'Оператор по аренде техники',
  other: 'Другое',
};

/**
 * Роль портала, которую пожелание подразумевает, — подсказка администратору для предзаполнения
 * формы активации. `null` — соответствия нет: арендодатель техники в портале не работает
 * (техника сдаётся в аренду, но её владелец учётки не получает), а «другое» на роль не
 * отображается по определению. Права всё равно даёт только назначенная роль.
 */
export const registrationRoleRequestRole: Record<RegistrationRoleRequest, Role | null> = {
  dispatcher: 'dispatcher',
  rukstroy: 'rukstroy',
  site_staff: 'shtab',
  waste_operator: 'operator',
  vehicle_lessor: null,
  other: null,
};

/** Что спросить дополнительно, чтобы пожелание было осмысленным. */
export type RegistrationRequestDetail = 'none' | 'object' | 'company';

export const registrationRequestDetail: Record<RegistrationRoleRequest, RegistrationRequestDetail> =
  {
    dispatcher: 'none',
    // Объектные роли работают в пределах объекта (ADR 0025) — без него заявку не рассмотреть.
    rukstroy: 'object',
    site_staff: 'object',
    // Оператор работает от лица контрагента (ADR 0010).
    waste_operator: 'company',
    vehicle_lessor: 'company',
    other: 'none',
  };

/** Уточнение — свободный текст: справочники неаутентифицированному не отдаются (ADR 0034). */
const detailField = z.string().trim().max(200);

export const registrationRequestFields = {
  requestedRole: registrationRoleRequestSchema,
  requestedObject: detailField.default(''),
  requestedCompany: detailField.default(''),
};

export interface RegistrationRequestInput {
  requestedRole: RegistrationRoleRequest;
  requestedObject: string;
  requestedCompany: string;
}

/** Пропущенное обязательное уточнение; `null` — заявка полна. */
export function registrationRequestIssue(
  value: RegistrationRequestInput,
): { field: 'requestedObject' | 'requestedCompany'; message: string } | null {
  const detail = registrationRequestDetail[value.requestedRole];
  if (detail === 'object' && !value.requestedObject.trim()) {
    return { field: 'requestedObject', message: 'Укажите объект' };
  }
  if (detail === 'company' && !value.requestedCompany.trim()) {
    return { field: 'requestedCompany', message: 'Укажите название компании' };
  }
  return null;
}

/** Стирает уточнение, которого выбранное пожелание не требует: «компания» у диспетчера — мусор. */
export function normalizeRegistrationRequest<T extends RegistrationRequestInput>(value: T): T {
  const detail = registrationRequestDetail[value.requestedRole];
  return {
    ...value,
    requestedObject: detail === 'object' ? value.requestedObject : '',
    requestedCompany: detail === 'company' ? value.requestedCompany : '',
  };
}
