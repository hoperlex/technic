import { z } from 'zod';

/**
 * Обмен справочниками через файл Excel (ADR 0073).
 *
 * Список справочников живёт в общем пакете, а не на сервере: портал строит по нему вкладку
 * администрирования, сервер — реестр описаний, и разъехавшись эти два списка дали бы кнопку,
 * ведущую в 404. Что именно умеет каждый справочник (колонки, ключ строки, правила разбора),
 * знает только сервер — здесь лежит ровно то, о чём обе стороны обязаны договориться.
 */

/**
 * Справочники, которые выгружаются и загружаются файлом. Ключ входит в адрес маршрута, поэтому
 * он kebab-case и совпадает с префиксом обычного маршрута справочника там, где тот есть.
 *
 * Порядок — тот, в котором справочники показываются на вкладке, и он же подсказывает порядок
 * загрузки: связанное идёт после того, на что ссылается (объекты раньше отделов, контрагенты
 * раньше складов и прайса, виды ТС раньше типов, типы оргтехники раньше моделей аппаратов, а те —
 * раньше самой оргтехники, которая ссылается на модель; она же идёт после объектов и отделов, на
 * которые ссылается карточка).
 */
export const DIRECTORY_KEYS = [
  'objects',
  'departments',
  'counterparties',
  'warehouses',
  'organizations',
  'container-types',
  'waste-types',
  'waste-tariffs',
  'vehicle-kinds',
  'vehicle-specs',
  'vehicle-types',
  'vehicle-categories',
  'vehicle-models',
  'vehicles',
  'office-equipment-types',
  'office-equipment-models',
  'office-equipment',
  'office-equipment-consumables',
  'specializations',
  'credential-types',
  'qualification-categories',
  'drivers',
] as const;

export type DirectoryKey = (typeof DIRECTORY_KEYS)[number];

export const directoryKeySchema = z.enum(DIRECTORY_KEYS);

/** Названия справочников — те же слова, что на вкладках портала. */
export const directoryTitles: Record<DirectoryKey, string> = {
  objects: 'Объекты',
  departments: 'Отделы',
  counterparties: 'Контрагенты',
  warehouses: 'Склады',
  organizations: 'Организации',
  'container-types': 'Типы контейнеров',
  'waste-types': 'Типы мусора',
  'waste-tariffs': 'Стоимость вывоза мусора',
  'vehicle-kinds': 'Виды ТС',
  'vehicle-specs': 'ТТХ',
  'vehicle-types': 'Типы ТС',
  'vehicle-categories': 'Категории типов ТС',
  'vehicle-models': 'Модели техники',
  vehicles: 'Техника',
  'office-equipment-types': 'Типы оргтехники',
  'office-equipment-models': 'Модели аппаратов',
  'office-equipment': 'Оргтехника',
  'office-equipment-consumables': 'Картриджи и тонеры',
  specializations: 'Специализации',
  'credential-types': 'Виды документов',
  'qualification-categories': 'Категории квалификаций',
  drivers: 'Водители',
};

/** Лист с данными: единственный, который читает загрузка. */
export const DIRECTORY_DATA_SHEET = 'Данные';

/** Лист-подсказка: как заполнять. Загрузка его не читает. */
export const DIRECTORY_HELP_SHEET = 'Справка';

/**
 * Служебная колонка с идентификатором записи. Заполнена у выгруженных строк, пуста у дописанных
 * человеком. Нужна ровно для одного: переименовать код записи. Без неё правка кода означала бы
 * не переименование, а заведение второй записи рядом с брошенной первой.
 */
export const DIRECTORY_ID_COLUMN = 'Идентификатор';

/**
 * Предел строк в файле. Справочник портала — это сотни строк; файл на тысячи означает, что
 * человек выгрузил не то или собрал таблицу не из того источника.
 */
export const DIRECTORY_IMPORT_MAX_ROWS = 5000;

/** Предел размера книги. Больше — либо не справочник, либо книга со вложенными картинками. */
export const DIRECTORY_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Тот же предел в знаках base64: четыре знака на три байта плюс выравнивание. */
export const DIRECTORY_IMPORT_MAX_BASE64 = Math.ceil(DIRECTORY_IMPORT_MAX_BYTES / 3) * 4 + 8;

/** Справочник в списке вкладки: чем он называется и сколько в нём строк сейчас. */
export interface DirectoryInfoDto {
  key: DirectoryKey;
  title: string;
  /** Строк в справочнике, включая погашенные: столько же уедет в файл. */
  count: number;
}

/** Одна правка в строке: колонка файла и её значение до и после. */
export interface DirectoryCellChangeDto {
  column: string;
  from: string;
  to: string;
}

/** Строка отчёта. `row` — номер строки на листе, как его видит человек в редакторе таблиц. */
export interface DirectoryRowReportDto {
  row: number;
  /** Чем строка называется человеку: код, наименование, ФИО. */
  title: string;
  /** Правки — только у изменяемых строк; у заводимых их нет по определению. */
  changes?: DirectoryCellChangeDto[];
}

/**
 * Что сделает (или сделала) загрузка. Один и тот же отчёт на предпросмотр и на применение:
 * второй показывает ровно то, что показал первый, — иначе предпросмотр не имел бы смысла.
 */
export interface DirectoryImportReportDto {
  /** true — база не менялась. Единственное различие двух отчётов. */
  dryRun: boolean;
  key: DirectoryKey;
  title: string;
  /** Строк с данными в файле (без шапки и пустых). */
  totalRows: number;
  created: DirectoryRowReportDto[];
  updated: DirectoryRowReportDto[];
  /** Строк, совпавших с заведённым до знака: их в отчёте перечислять незачем. */
  unchanged: number;
  /**
   * Негодные строки, дословно и с номерами. Пока список не пуст, файл не применяется ни одной
   * строкой: половина заведённого справочника хуже невыполненной загрузки — её сверять построчно.
   */
  problems: string[];
  /** Применению не мешают, но прочитать их человек обязан: однофамильцы, пропущенные документы. */
  warnings: string[];
}

/**
 * Тело загрузки. Файл едет base64 в JSON, а не multipart: multipart в API нет вовсе (вложения
 * заявок уходят прямо в S3), и заводить его ради книги в двести килобайт значило бы завести
 * второй способ принимать файлы. Предел размера тела поднят на самом маршруте.
 */
export const directoryImportSchema = z
  .object({
    /** Предпросмотр: разобрать, сверить, показать — и не писать ни строки. */
    dryRun: z.boolean(),
    /** Имя выбранного файла: попадает в журнал, чтобы загрузку можно было опознать потом. */
    filename: z.string().trim().max(255).default(''),
    contentBase64: z.string().min(1).max(DIRECTORY_IMPORT_MAX_BASE64),
  })
  .strict();

export type DirectoryImportBody = z.infer<typeof directoryImportSchema>;
