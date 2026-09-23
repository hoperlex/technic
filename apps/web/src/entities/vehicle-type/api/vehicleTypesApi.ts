import type {
  AttachVehicleTypeSpecInput,
  CreateVehicleCategoryInput,
  CreateVehicleSpecInput,
  CreateVehicleTypeInput,
  ListResult,
  SwitchVehicleTypeLinearInput,
  UpdateVehicleCategoryInput,
  UpdateVehicleSpecInput,
  UpdateVehicleTypeInput,
  UpdateVehicleTypeResult,
  UpdateVehicleTypeSpecInput,
  VehicleCategoryDto,
  VehicleClassificationDto,
  VehicleKindDto,
  VehicleSpecDto,
  VehicleTypeDto,
  VehicleTypeLinearSwitchPreviewDto,
  VehicleTypeLinearSwitchResultDto,
  VehicleTypeSpecDto,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';

/**
 * Справочник «что за техника»: вид → тип → ТТХ типа → категория, и классификатор как взгляд на всё
 * это одним списком (ADR 0016, ADR 0028).
 *
 * Пять ручек одним файлом, потому что это один справочник, а не пять. Тип не значит ничего без
 * своего вида, категория — это кортеж значений ТТХ своего типа, а классификатор не имеет
 * собственных данных вовсе: он сводит типы с категориями в плоский список. Правило «общий тип при
 * наличии категорий не выводится» одно на все четыре уровня, и записано оно ровно один раз — ниже,
 * у `vehicleClassificationsApi`. Разложенное по пяти файлам, оно разошлось бы копиями или осталось
 * невидимым четырём из пяти — а расходятся такие копии молча.
 */

/**
 * Виды ТС — верхний уровень справочника («Спецтехника», «Грузоперевозки»): им заполняют поле вида
 * в форме типа и фильтр классификатора.
 *
 * Ручка одна, и это не начатая работа: сервер вид только отдаёт и писать его не даёт
 * (`apps/api/src/routes/vehicle-kinds.ts`). Заведи здесь `create` — и форма получила бы кнопку, на
 * которую сервер отвечает 404.
 */
export const vehicleKindsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleKindDto>>('/vehicle-kinds', { query: q }),
};

export const vehicleTypesApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleTypeDto>>('/vehicle-types', { query: q }),
  create: (body: CreateVehicleTypeInput) =>
    apiFetch<VehicleTypeDto>('/vehicle-types', { method: 'POST', body }),
  // Только описательные поля (типа) + isActive (подтипа). Структурные поля неизменяемы.
  // Признака линейности здесь нет: у переключения свой протокол (см. ниже), а этой ручке сервер
  // отвечает на него 422 — иначе подтверждение обходилось бы вкладкой, открытой со вчера.
  // Ответ — обёртка `{ type, unhitchedTrailers, unhitchedVehicles }`, а не карточка: перевод типа
  // на бланк «форма № 3» снимает привязки прицепов у всех машин типа разом
  // (`docs/vehicle-trailers-plan.md`, §4.2.3).
  update: (id: string, body: UpdateVehicleTypeInput) =>
    apiFetch<UpdateVehicleTypeResult>(`/vehicle-types/${id}`, { method: 'PATCH', body }),
  /**
   * Что случится, если признак линейности переключить: сколько заявок останется на прежнем режиме,
   * какие именно и сколько из них лежит в архиве. Ничего не пишет — это чтение для диалога.
   *
   * `fingerprint` из ответа предъявляется переключению: между «показали номера» и «нажали» состав
   * заявок меняется, и подтверждали тогда не то, что записывается.
   */
  linearSwitchPreview: (id: string, isLinear: boolean) =>
    apiFetch<VehicleTypeLinearSwitchPreviewDto>(`/vehicle-types/${id}/linear-switch-preview`, {
      query: { isLinear },
    }),
  /**
   * Переключить признак линейности. Заявки в работе не отменяются и не переводятся: каждая
   * запоминает режим, которым её завели, и дорабатывает по нему — их номера приходят в ответе.
   *
   * Без `fingerprint` при непустом множестве сервер отвечает 422 «нужно подтверждение», при
   * разошедшемся — 409: ни то, ни другое ничего не записывает.
   */
  switchLinear: (id: string, body: SwitchVehicleTypeLinearInput) =>
    apiFetch<VehicleTypeLinearSwitchResultDto>(`/vehicle-types/${id}/linear`, {
      method: 'POST',
      body,
    }),
  // ТТХ типа (ADR 0016): привязка означает обязательность значения у каждой категории типа,
  // поэтому все четыре ручки возвращают актуальный набор ТТХ целиком.
  specs: (id: string) => apiFetch<VehicleTypeSpecDto[]>(`/vehicle-types/${id}/specs`),
  attachSpec: (id: string, body: AttachVehicleTypeSpecInput) =>
    apiFetch<VehicleTypeSpecDto[]>(`/vehicle-types/${id}/specs`, { method: 'POST', body }),
  updateSpec: (id: string, specId: string, body: UpdateVehicleTypeSpecInput) =>
    apiFetch<VehicleTypeSpecDto[]>(`/vehicle-types/${id}/specs/${specId}`, {
      method: 'PATCH',
      body,
    }),
  detachSpec: (id: string, specId: string) =>
    apiFetch<VehicleTypeSpecDto[]>(`/vehicle-types/${id}/specs/${specId}`, { method: 'DELETE' }),
  /** Удаление насовсем (ADR 0060): категории и привязки ТТХ уходят вместе с типом. */
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-types/${id}/purge`, { method: 'DELETE' }),
};

// ── ТТХ и категории типов ТС (ADR 0016) ──
export const vehicleSpecsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleSpecDto>>('/vehicle-specs', { query: q }),
  create: (body: CreateVehicleSpecInput) =>
    apiFetch<VehicleSpecDto>('/vehicle-specs', { method: 'POST', body }),
  // `code` неизменяем; `unit`/`decimals` сервер запретит менять, как только ТТХ привязан к типам.
  update: (id: string, body: UpdateVehicleSpecInput) =>
    apiFetch<VehicleSpecDto>(`/vehicle-specs/${id}`, { method: 'PATCH', body }),
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-specs/${id}/purge`, { method: 'DELETE' }),
};

export const vehicleCategoriesApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleCategoryDto>>('/vehicle-categories', { query: q }),
  create: (body: CreateVehicleCategoryInput) =>
    apiFetch<VehicleCategoryDto>('/vehicle-categories', { method: 'POST', body }),
  update: (id: string, body: UpdateVehicleCategoryInput) =>
    apiFetch<VehicleCategoryDto>(`/vehicle-categories/${id}`, { method: 'PATCH', body }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-categories/${id}`, { method: 'DELETE' }),
};

/**
 * Классификатор ТС одним списком (ADR 0028): тип с категориями раскрыт в категории, тип без
 * категорий — сам собой. Им заполняются все места, где выбирают «что заказываем» и «что это за
 * машина»: правило «общий тип при наличии категорий не выводится» одно на портал.
 */
export const vehicleClassificationsApi = {
  list: (q: Query) =>
    apiFetch<ListResult<VehicleClassificationDto>>('/vehicle-classifications', { query: q }),
};
