import type { FileDto, RequestChangeDto, RequestChangeFileDto } from '@technic/contracts';

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
 * Календарный ключ `YYYY-MM-DD` человеку: `24.07.2026`.
 *
 * Разбором строки, а не через `Date`: у ключа нет времени, и разбор датой увёл бы его на день в
 * чужом поясе. Контракты такой функции не отдают — ключ там календарный, а это его написание для
 * человека, то есть часть той же механики события, что `short` и `EMPTY`.
 */
export function dateKeyRu(key: string): string {
  const [y, m, d] = key.split('-');
  return y && m && d ? `${d}.${m}.${y}` : key;
}

/**
 * Деньги человеку: 1 200,00 ₽. Ставка и итог показываются одинаково — их и сравнивают глазами.
 *
 * Это написание журнала правок, а не всякой суммы в портале: выгрузки печатают числа голыми
 * (`toFixed`), потому что их читает не человек, а таблица.
 */
export function money(v: number | null): string {
  if (v == null) return EMPTY;
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Перечень файлов одной строкой — ОДНОЙ функцией у писателя диффа и у читателя истории
 * (`request-history.ts`): читатель пересобирает эту строку после того, как имена прошли правило
 * карантина, и разойдись две сборки, в истории завелись бы два написания одного и того же события.
 *
 * Файл без имени в строку не попадает вовсе. Имя запертого файла — пустая строка (правило
 * `file-view.ts`), и склейка оставила бы на его месте голую запятую, то есть «что-то потерялось»
 * вместо «файл скрыт по обращению»; сам файл при этом никуда не исчезает — он остаётся строкой в
 * `files` события вместе со своим признаком.
 */
export function fileListText(items: readonly RequestChangeFileDto[]): string {
  return short(
    items
      .map((f) => f.filename)
      .filter((name) => name !== '')
      .join(', '),
  );
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
     * Событие-список про файлы: рядом с именами едут ИДЕНТИФИКАТОРЫ, и без них событие неполно.
     *
     * Имена попадают в журнал в момент подшивки, а карантин ошибочно загруженного документа
     * ставят позже — по инциденту, который обнаружили потом (план освобождения от подписи, Р6,
     * п. 4). Журнал заявки не переписывают, значит гасить имя приходится при чтении истории, а для
     * этого читателю нужно знать, О КАКОМ файле идёт речь. Одного имени для этого не хватает: по
     * имени файл не ищется — их бывает два одинаковых, и строки файла может уже не быть.
     */
    fileList(field: string, items: readonly RequestChangeFileDto[]): void {
      if (items.length === 0) return;
      changes.push({ field, from: null, to: fileListText(items), files: [...items] });
    },
    /**
     * Файлы сравниваются по составу, а не по количеству: «было 3, стало 3» скрыло бы замену
     * одного документа другим.
     */
    files(before: readonly FileDto[], after: readonly FileDto[]): void {
      const was = new Set(before.map((f) => f.id));
      const now = new Set(after.map((f) => f.id));
      const pairs = (
        rows: readonly FileDto[],
        other: ReadonlySet<string>,
      ): RequestChangeFileDto[] =>
        rows.filter((f) => !other.has(f.id)).map((f) => ({ id: f.id, filename: f.filename }));
      this.fileList('filesAdded', pairs(after, was));
      this.fileList('filesRemoved', pairs(before, now));
    },
  };
}
