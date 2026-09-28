/**
 * Учётная запись портала (ADR 0092, ADR 0102): кто входит, с какой ролью и областью, к какому
 * работнику привязан и что с учёткой можно сделать — завести, поправить, сдать в архив, вернуть
 * оттуда, отказать по заявке на регистрацию. Снаружи берут `@entities/user-account` — внутренние
 * модули слайса не видны, и перестроить его можно, не трогая потребителей.
 *
 * Карточки учётки здесь нет и не будет: `UserAccountDto` живёт в контрактах (ADR 0102), и страницы
 * берут её там же, где берут остальной словарь портала. Отсюда раздаются только те типы, которых
 * в контрактах нет, — тела запроса и кандидаты на привязку.
 */
export { userAccountKeys } from './api/keys';
export { usersApi } from './api/usersApi';
export type {
  DriverPersonBody,
  PersonCandidateDto,
  PersonCandidateMatch,
  RestoreUserBody,
  UserAccountMutationResult,
} from './api/usersApi';

/*
 * Поля учётки: правила пароля и разбор ФИО. Оба спрашивают контракты (`passwordStrength`,
 * `namePartIssue`), и оба нужны и регистрации, и администратору — держать их у одного из экранов
 * значило бы, что второй читает правило через чужую страницу.
 */
export { PasswordField } from './ui/PasswordField';
export { PersonNameFields } from './ui/PersonNameFields';

/*
 * The contact phone: the field, the mask behind it and the number as a `tel:` link (ADR 0066).
 *
 * They sit in the account slice because the account is the one record that always has a number,
 * and the mask asks the contracts (`normalizePhone`, `PHONE_DIGITS`, `PHONE_PLACEHOLDER`) — which
 * `shared` is not allowed to do. `PhoneInput` is exported on its own, and not only through the
 * form field: rows of a form that has no `Form.Item` per cell (the weekly request) hold the input
 * directly, and a second mask written for them would drift from this one on the first fix.
 *
 * A neighbour on this layer cannot take them from here (`entities/request` and `ResponsibleFields`
 * among them), so such a caller is handed the input as a prop by whoever renders it — the decision
 * is written down in the wave plan, and it is what keeps the mask a single place.
 */
export { PhoneField, PhoneLink } from './ui/PhoneField';
export { PhoneInput } from './ui/PhoneInput';
