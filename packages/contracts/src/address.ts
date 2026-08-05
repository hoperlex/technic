import { z } from 'zod';
import { uuidSchema } from './common';

// ── Адрес: строка и метаданные ──
// Каноническая строка адреса лежит в поле сущности (`loadingLocation`/`unloadingLocation` и т. п.);
// здесь — происхождение адреса и то, чем он опознан: ФИАС, гео, запись справочника.
//
// Форма адреса живёт своим модулем, а не внутри заявки на технику: метаданные постепенно получают
// все адреса портала (справочники объектов и складов, перегон), и импортировать их форму из модуля
// заказа техники было бы неправдой о том, кому они принадлежат.
//
// Жёсткая модель (ADR 0006) действует там, где её включает схема сущности: адрес погрузки и
// разгрузки ОБЯЗАТЕЛЕН и должен быть верифицирован — выбран из подсказок DaData либо из
// справочника. `manual` остаётся в enum только для чтения легаси-строк, на запись он не проходит.

/**
 * Откуда взялся адрес: подсказка DaData (`resolved`), справочник объектов (`object`), справочник
 * складов поставщиков (`warehouse`), свободный ввод до ужесточения модели (`manual`).
 */
export const ADDRESS_SOURCES = ['resolved', 'manual', 'object', 'warehouse'] as const;
export const addressSourceSchema = z.enum(ADDRESS_SOURCES);
export type AddressSource = (typeof ADDRESS_SOURCES)[number];

/** Источники-справочники: у них адрес не набран, а выбран записью, и опознаётся ссылкой на неё. */
export function isDirectoryAddressSource(source: AddressSource): boolean {
  return source === 'object' || source === 'warehouse';
}

/**
 * Метаданные адреса. `fiasId` — не строго UUID (DaData отдаёт разные GUID), поэтому просто строка.
 *
 * `refId` — выбранная запись справочника (объект или склад). Хранится вместе с адресом, а не
 * вместо него: заявка помнит, куда ехали, а справочник живёт своей жизнью и адрес записи потом
 * могут поправить.
 */
export const addressMetaSchema = z
  .object({
    source: addressSourceSchema,
    fiasId: z.string().trim().min(1).max(64).nullable().optional(),
    fiasLevel: z.number().int().min(-1).max(99).nullable().optional(),
    geoLat: z.number().min(-90).max(90).nullable().optional(),
    geoLon: z.number().min(-180).max(180).nullable().optional(),
    refId: uuidSchema.nullable().optional(),
  })
  .strict();
export type AddressMeta = z.infer<typeof addressMetaSchema>;

/** Адрес верифицирован: выбран из справочника (объект, склад) или из подсказок DaData (с ФИАС). */
export function isAddressVerified(meta: AddressMeta | null | undefined): boolean {
  if (!meta) return false;
  return isDirectoryAddressSource(meta.source) || (meta.source === 'resolved' && !!meta.fiasId);
}

export const ADDRESS_NOT_VERIFIED_MESSAGE =
  'Адрес нужно выбрать из подсказок DaData либо из справочника';

/**
 * Верифицированный адрес для записи (жёсткая модель, ADR 0006). Принимается адрес из подсказки
 * DaData (`resolved` + ФИАС) либо из справочника (`object`/`warehouse` + ссылка на запись).
 *
 * У справочного источника ФИАС **допустим**, а не запрещён: сегодня его неоткуда взять — адрес в
 * справочнике сам хранится строкой, — но когда записи справочника получат свои метаданные, ФИАС
 * будет наследоваться от выбранной записи, и «выбран из справочника» станет проверяемым, а не
 * доверием к справочнику. Запрети его сейчас — и тот шаг потребовал бы правки схемы и перебора
 * уже записанных строк.
 */
export const verifiedAddressMetaSchema = addressMetaSchema.superRefine((meta, ctx) => {
  if (!isAddressVerified(meta)) {
    ctx.addIssue({ code: 'custom', message: ADDRESS_NOT_VERIFIED_MESSAGE });
    return;
  }
  if (isDirectoryAddressSource(meta.source)) {
    // Без ссылки «выбран из справочника» — это утверждение без записи за ним: ни проверить на
    // сервере, ни восстановить выбор при правке заявки.
    if (!meta.refId) {
      ctx.addIssue({
        code: 'custom',
        path: ['refId'],
        message: 'Не указана запись справочника, из которой выбран адрес',
      });
    }
  } else if (meta.refId) {
    ctx.addIssue({
      code: 'custom',
      path: ['refId'],
      message: 'Ссылка на справочник бывает только у адреса, выбранного из справочника',
    });
  }
});
