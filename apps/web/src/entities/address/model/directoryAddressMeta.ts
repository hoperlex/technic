import type { AddressMeta } from '@technic/contracts';

/** Запись справочника, которой отвечают на вопрос «куда ехать»: объект или склад поставщика. */
export interface DirectoryAddressRecord {
  kind: 'object' | 'warehouse';
  id: string;
  address: string;
}

/**
 * Метаданные адреса, выбранного из справочника (ADR 0069).
 *
 * Ссылка на запись — всё, чем такой адрес подтверждается: ФИАС у него нет, потому что справочник
 * сам хранит адрес строкой. Когда записи справочника получат свои метаданные, наследование ФИАС
 * добавится здесь одной правкой — потребители не изменятся, поэтому на вход идёт запись целиком,
 * а не пара «вид + идентификатор»: наследовать было бы неоткуда.
 */
export function directoryAddressMeta(record: DirectoryAddressRecord): AddressMeta {
  return { source: record.kind, refId: record.id };
}
