import { z } from 'zod';
import { isInternalEmail } from './email';
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
  'commandant',
  'waste_operator',
  'vehicle_lessor',
  // Водитель (ADR 0102): единственное пожелание, чья роль совпадает с ним буквально. Отдельной
  // кнопки «Я водитель» на экране входа нет — человек выбирает себя в общем списке.
  'driver',
  'other',
] as const;
export const registrationRoleRequestSchema = z.enum(REGISTRATION_ROLE_REQUESTS);
export type RegistrationRoleRequest = (typeof REGISTRATION_ROLE_REQUESTS)[number];

export const registrationRoleRequestLabels: Record<RegistrationRoleRequest, string> = {
  dispatcher: 'Диспетчер',
  rukstroy: 'Руководитель строительства',
  // «Штаб» — название из таблицы прав; заявителю оно ничего не говорит.
  site_staff: 'Сотрудник объекта',
  // Комендант, наоборот, назван своей должностью: так он себя и называет, и роль в портале
  // совпадает с ней. Отдельным вариантом, а не внутри «сотрудника объекта», — это разные роли:
  // коменданту заказ техники закрыт, и по пожеланию администратор видит, какую назначать.
  commandant: 'Комендант',
  waste_operator: 'Оператор по вывозу мусора',
  vehicle_lessor: 'Оператор по аренде техники',
  // Как человек себя называет; машинист и тракторист выберут её же — кабинет открыт любой
  // должности справочника (ADR 0102).
  driver: 'Водитель',
  other: 'Другое',
};

/**
 * Роль портала, которую пожелание подразумевает, — подсказка администратору для предзаполнения
 * формы активации. `null` — соответствия нет: «другое» на роль не отображается по определению.
 * Права всё равно даёт только назначенная роль.
 *
 * Оба исполнителя ведут к одной роли: что именно человек исполняет — вывоз мусора или аренду
 * техники, — задаёт не роль, а тип контрагента, которого администратор выберет в форме
 * (ADR 0038). Само пожелание при этом различает их, потому что заявитель называет себя иначе, и
 * по нему администратор понимает, какого контрагента искать.
 */
export const registrationRoleRequestRole: Record<RegistrationRoleRequest, Role | null> = {
  dispatcher: 'dispatcher',
  rukstroy: 'rukstroy',
  site_staff: 'shtab',
  commandant: 'commandant',
  waste_operator: 'operator',
  vehicle_lessor: 'operator',
  driver: 'driver',
  other: null,
};

/** Что спросить дополнительно, чтобы пожелание было осмысленным. */
export type RegistrationRequestDetail = 'none' | 'object' | 'company' | 'comment';

export const registrationRequestDetail: Record<RegistrationRoleRequest, RegistrationRequestDetail> =
  {
    dispatcher: 'none',
    // Объектные роли работают в пределах объекта (ADR 0025) — без него заявку не рассмотреть.
    rukstroy: 'object',
    site_staff: 'object',
    commandant: 'object',
    // Оператор работает от лица контрагента (ADR 0010).
    waste_operator: 'company',
    vehicle_lessor: 'company',
    // Ни объекта, ни компании у водителя не спрашивают: он работает от парка, а привязку к
    // карточке справочника делает администратор при активации (ADR 0102).
    driver: 'none',
    // «Другое» — единственное пожелание, которому в портале не соответствует никакая роль
    // (`registrationRoleRequestRole.other = null`). Без объяснения своими словами такая заявка не
    // содержит ничего, кроме ФИО и адреса: администратору не из чего выбирать роль, и решается
    // она звонком — ровно тем, ради отмены которого пожелание и заводили (ADR 0034).
    other: 'comment',
  };

/**
 * Ждут ли от заявителя рабочий адрес в домене компании (ADR 0090).
 *
 * У операторов — нет: они работают от лица сторонней организации (ADR 0010), рабочая почта у них
 * по определению не наша, и предупреждение о «внешнем» адресе требовало бы от них невозможного.
 * У «другого» — да: так себя называет чаще свой сотрудник, которому роль подберут при
 * рассмотрении.
 *
 * Таблица отдельная, а не вывод из `registrationRequestDetail`: совпадение с «спрашиваем
 * компанию» случайное, и следующее пожелание сломало бы его молча.
 */
const requestExpectsCorporateEmail: Record<RegistrationRoleRequest, boolean> = {
  dispatcher: true,
  rukstroy: true,
  site_staff: true,
  commandant: true,
  waste_operator: false,
  vehicle_lessor: false,
  // Почта у водителя личная по определению: предупреждение о «внешнем» адресе требовало бы от
  // него невозможного.
  driver: false,
  other: true,
};

export function expectsCorporateEmail(request: RegistrationRoleRequest): boolean {
  return requestExpectsCorporateEmail[request];
}

/**
 * Заявка подана с чужого адреса там, где ждали рабочий. Отказом это не является — признак нужен
 * администратору, чтобы приглядеться к заявке, и заявителю, чтобы одуматься до отправки.
 */
export function isExternalRegistrationEmail(value: {
  email: string;
  requestedRole: RegistrationRoleRequest | null;
}): boolean {
  if (!value.requestedRole || !expectsCorporateEmail(value.requestedRole)) return false;
  return !isInternalEmail(value.email);
}

/** Уточнение — свободный текст: справочники неаутентифицированному не отдаются (ADR 0034). */
const detailField = z.string().trim().max(200);

export const registrationRequestFields = {
  requestedRole: registrationRoleRequestSchema,
  requestedObject: detailField.default(''),
  requestedCompany: detailField.default(''),
  requestedComment: detailField.default(''),
};

export interface RegistrationRequestInput {
  requestedRole: RegistrationRoleRequest;
  requestedObject: string;
  requestedCompany: string;
  requestedComment: string;
}

/** Пропущенное обязательное уточнение; `null` — заявка полна. */
export function registrationRequestIssue(
  value: RegistrationRequestInput,
): { field: 'requestedObject' | 'requestedCompany' | 'requestedComment'; message: string } | null {
  const detail = registrationRequestDetail[value.requestedRole];
  if (detail === 'object' && !value.requestedObject.trim()) {
    return { field: 'requestedObject', message: 'Укажите объект' };
  }
  if (detail === 'company' && !value.requestedCompany.trim()) {
    return { field: 'requestedCompany', message: 'Укажите название компании' };
  }
  if (detail === 'comment' && !value.requestedComment.trim()) {
    return { field: 'requestedComment', message: 'Напишите, кем вы работаете' };
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
    requestedComment: detail === 'comment' ? value.requestedComment : '',
  };
}
