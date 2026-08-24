import type {
  AutoPartDetailDto,
  AutoPartDto,
  AutoPartStockInput,
  AutoPartStockResultDto,
  CreateAutoPartBody,
  UpdateAutoPartBody,
} from '@technic/contracts';
import {
  apiFetch,
  createGetApi,
  createListApi,
  createRemoveApi,
  createWriteApi,
} from '@shared/api';

/**
 * Клиент склада автозапчастей (план `docs/auto-parts-plan.md`, §7): перечень, карточка с лентой
 * журнала, ведение позиции и движение остатка.
 *
 * Формы ответов сюда не переписываются — они описаны в `@technic/contracts`, и сервер отдаёт
 * ровно их. Тела правки и заведения тоже контрактные, и различаются они намеренно: `create`
 * принимает начальный остаток (Р17), а `update` его не принимает вовсе (`quantity: z.never()`) —
 * приняв количество и не записав его, форма соврала бы человеку.
 */

/** Своя ветка модуля: склад существует и без акта обслуживания, а не как его придаток (Р4). */
const BASE = '/auto-parts';

export const autoPartApi = {
  /**
   * Перечень: поиск по наименованию и коду сразу, фильтры наличия, активности и применимости,
   * страницы (Р13). Подбор под машину (`vehicleId`, Р21) — тот же список: ранг считает сервер,
   * потому что страница у списка конечна, а досортировка пришедшей страницы оставила бы
   * подходящую деталь на седьмой.
   */
  ...createListApi<AutoPartDto>(BASE),
  /** Карточка целиком: сама позиция и лента её журнала — в списке этой ленты нет (§6). */
  ...createGetApi<AutoPartDetailDto>(BASE),
  ...createWriteApi<AutoPartDto, CreateAutoPartBody, UpdateAutoPartBody>(BASE),
  /** Удаление — пока по позиции нет ни одного движения: дальше только гашение (Р11). */
  ...createRemoveApi<{ ok: boolean }>(BASE),
  /**
   * Правка остатка своей ручкой (Р3): новое значение, то значение, которое человек видел
   * (`expectedQuantity`), и обязательная причина.
   *
   * `expectedQuantity` — не формальность: без него два механика, открывшие карточку с числом 12,
   * запишут «12 → 10» и «12 → 8», и журнал станет враньём при верном итоге. Разошлось — сервер
   * отвечает 409 «остаток изменил другой человек, сейчас N»; это нормальный исход одновременной
   * работы, а не сбой, и окно правки показывает его словами, перечитывая карточку.
   */
  setStock: (id: string, body: AutoPartStockInput) =>
    apiFetch<AutoPartStockResultDto>(`${BASE}/${id}/stock`, { method: 'POST', body }),
};
