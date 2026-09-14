/**
 * Ошибки конфигурации и политик.
 *
 * Отдельный класс нужен ради одного свойства: такие ошибки печатаются человеку как «поправьте
 * файл», а не как стек. Ошибка в политике — это не сбой программы, и показывать её стеком значит
 * прятать единственное, что человеку нужно: имя файла и поле.
 */
export class MaintenanceConfigError extends Error {
  readonly file: string;

  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'MaintenanceConfigError';
    this.file = file;
  }
}
