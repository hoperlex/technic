/**
 * Учётки и журнал действий с ними, назначаемые полномочия и почтовый контур переехали в соседние
 * файлы: каждый из этих доменов описывает не столько ручки, сколько правила обращения с ними
 * (отпечаток последствий у полномочий, тела запроса у учёток, портальные типы ответов у рассылок),
 * и объяснять их посреди справочников техники — значит прятать объяснение.
 *
 * Реэкспорт, а не переезд импортов: адрес `api/resources` знают три десятка экранов, и менять их
 * все ради разреза реестра — правка, которую невозможно проверить глазами. Новые ручки этих
 * доменов добавляются в свой файл, а не сюда.
 */
export { auditApi, usersApi } from './users';
export type {
  DriverPersonBody,
  PersonCandidateDto,
  PersonCandidateMatch,
  RestoreUserBody,
  UserAccountDto,
  UserAccountMutationResult,
  UserPersonRefDto,
} from './users';
export { grantFormApi, grantKeys, grantsApi, userGrantsApi, type GrantCatalog } from './grants';
export { mailingsApi } from './mailings';
export type {
  MailDigestSampleUser,
  MailingRunStats,
  MailTestDriver,
  MailTestRecipient,
} from './mailings';

/**
 * Отделы переехали в `@entities/department`. Реэкспорт держится до конца этапа 2 на тех же
 * условиях, что у объектов: новые ручки добавляются в слайс, а не сюда.
 */
export { departmentsApi } from '@entities/department';

/**
 * Объекты переехали в `@entities/object`. Реэкспорт держится до конца этапа 2: по этому пути
 * импортируют ещё не переведённые экраны, а параллельная работа пишет новый код. Новые ручки
 * добавляются в слайс, а не сюда, — иначе правка встретится с разрезом конфликтом.
 */
export { objectsApi } from '@entities/object';

/**
 * Водители переехали в `@entities/driver`. Реэкспорт держится на тех же условиях, что у объектов:
 * по этому адресу импортируют ещё не переведённые экраны, а новые ручки добавляются в слайс, а не
 * сюда, — иначе правка встретится с разрезом конфликтом.
 */
export { driversApi } from '@entities/driver';

/**
 * Журнал путевых листов переехал в `@entities/waybill`. Реэкспорт держится на тех же условиях, что
 * у объектов: по этому адресу листы берут ещё не переведённые экраны, новые ручки добавляются в
 * слайс, а не сюда.
 */
export { waybillsApi } from '@entities/waybill';

/**
 * Рейсы переехали в `@entities/vehicle-route`. Реэкспорт держится на тех же условиях, что у
 * объектов: по этому адресу их берут ещё не переведённые экраны, новые ручки добавляются в слайс,
 * а не сюда.
 */
export { vehicleRoutesApi } from '@entities/vehicle-route';

/**
 * Контрагенты переехали в `@entities/counterparty`. Реэкспорт держится на тех же условиях, что у
 * объектов: по этому адресу справочник берут ещё не переведённые экраны, новые ручки добавляются в
 * слайс, а не сюда.
 */
export { counterpartiesApi } from '@entities/counterparty';

/**
 * Склады поставщиков переехали в `@entities/warehouse`. Реэкспорт держится до конца этапа 2 на тех
 * же условиях, что у объектов: новые ручки добавляются в слайс, а не сюда.
 */
export { warehousesApi } from '@entities/warehouse';

/**
 * Типы контейнеров переехали в `@entities/container-type`; реэкспорт держится до конца этапа 2 тем
 * же порядком, что у объектов. Новые ручки добавляются в слайс, а не сюда.
 */
export { containerTypesApi } from '@entities/container-type';

/**
 * Классификатор техники переехал в `@entities/vehicle-type` — пятью ручками разом: вид, тип, ТТХ,
 * категория и сведённый список позиций отвечают на один вопрос «что за техника бывает», и правило
 * про общий тип при наличии категорий у них одно. Реэкспорт держится на тех же условиях, что у
 * объектов.
 */
export {
  vehicleCategoriesApi,
  vehicleClassificationsApi,
  vehicleKindsApi,
  vehicleSpecsApi,
  vehicleTypesApi,
} from '@entities/vehicle-type';

/**
 * Парк машин и их марки переехали в `@entities/vehicle`. Модель не отдельным слайсом потому, что
 * не отдельный справочник: она принадлежит типу, живёт полем формы машины и портал её не пишет.
 * Реэкспорт держится на тех же условиях, что у объектов.
 */
export { vehicleModelsApi, vehiclesApi } from '@entities/vehicle';

/**
 * Заказ ТС переехал в `@entities/vehicle-request` вместе с портальными ответами своих дверей:
 * состояние заявки после команды описано не в контрактах, а рядом с ручкой, которая его отдаёт, —
 * там же, где объяснено, почему повтор по тому же ключу операции отвечает то же самое.
 * Реэкспорт держится на тех же условиях, что у объектов.
 */
export { vehicleRequestsApi } from '@entities/vehicle-request';
export type {
  AssignmentCommandResultDto,
  VehicleRequestCompletionResultDto,
  VehicleRequestPeriodResultDto,
} from '@entities/vehicle-request';

/**
 * Недельная заявка на технику переехала в `@entities/weekly-request` — тем же порядком, что типы
 * мусора и прайс: ручки живут рядом со своими ключами, а здесь остаётся имя, по которому их зовут
 * страницы. Слайс был заведён под ключи заранее и ждал именно этого переезда.
 */
export { weeklyRequestsApi } from '@entities/weekly-request';
export type {
  WeeklyDecisionResultDto,
  WeeklyRequestHistoryEntryDto,
  WeeklyRequestHistoryEvent,
} from '@entities/weekly-request';

/**
 * Заявки на вывоз мусора переехали в `@entities/waste-request` вместе с телами своих запросов:
 * форма страницы шлёт их же, а описаны они не в контрактах, а здесь — значит место им рядом с
 * ручками, которые их принимают. Реэкспорт держится на тех же условиях, что у объектов.
 */
export { wasteRequestsApi } from '@entities/waste-request';
export type { WasteRequestPayload, WasteRequestUpdatePayload } from '@entities/waste-request';

/**
 * Вложения переехали в `@entities/file`. Реэкспорт держится на тех же условиях, что у объектов:
 * по этому адресу их берут ещё не переведённые экраны, новые ручки добавляются в слайс, а не сюда.
 */
export { filesApi } from '@entities/file';

/**
 * Обмен справочниками переехал в `@entities/directory-transfer`. Реэкспорт держится на тех же
 * условиях, что у объектов.
 */
export { directoriesApi } from '@entities/directory-transfer';
