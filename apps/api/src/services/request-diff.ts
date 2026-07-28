import type { FileDto, RequestChangeDto } from '@technic/contracts';

// Общая механика диффа правки заявки — то, из чего складывается история в её карточке (ADR 0012).
// Сравниваются DTO «до» и «после», а не сырые колонки: человеку нужны названия справочников и
// суммы, а не идентификаторы. Модуль намеренно не знает о БД — так его считает и проверяет тест
// без поднятого приложения. Что именно сравнивать, решает дифф своего модуля.

/** Значение, которого нет: пустой комментарий и незаполненное поле читаются одинаково. */
export const EMPTY = '—';

/** Больше в историю не помещается: смысл правки виден по началу значения. */
const MAX_VALUE_LENGTH = 300;

export function short(value: string): string {
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}

/**
 * Набор изменений одной правки. Порядок вызовов — он же порядок строк в карточке, поэтому
 * поля перечисляются так, как они идут в форме.
 */
export function changeSet() {
  const changes: RequestChangeDto[] = [];
  return {
    changes,
    /** Пара «было → стало»; совпавшие значения событием не считаются. */
    changed(field: string, from: string, to: string): void {
      if (from !== to) changes.push({ field, from, to });
    },
    /** Событие-список: значима только правая часть («прикреплены файлы: акт.pdf»). */
    listed(field: string, items: string[]): void {
      if (items.length > 0) changes.push({ field, from: null, to: short(items.join(', ')) });
    },
    /**
     * Файлы сравниваются по составу, а не по количеству: «было 3, стало 3» скрыло бы замену
     * одного документа другим.
     */
    files(before: readonly FileDto[], after: readonly FileDto[]): void {
      const was = new Map(before.map((f) => [f.id, f.filename]));
      const now = new Map(after.map((f) => [f.id, f.filename]));
      this.listed(
        'filesAdded',
        [...now].filter(([id]) => !was.has(id)).map(([, name]) => name),
      );
      this.listed(
        'filesRemoved',
        [...was].filter(([id]) => !now.has(id)).map(([, name]) => name),
      );
    },
  };
}
