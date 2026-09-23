import type {
  DirectoryImportBody,
  DirectoryImportReportDto,
  DirectoryInfoDto,
  DirectoryKey,
} from '@technic/contracts';
import { apiDownload, apiFetch } from '@shared/api';

/**
 * Обмен справочниками через файл Excel (ADR 0073). Ручки общие на все справочники: какой именно
 * выгружается и загружается, задаёт ключ в адресе. Восемнадцать одноимённых ресурсов означали бы
 * восемнадцать мест, где один и тот же запрос назван по-своему.
 */
export const directoriesApi = {
  /** Список со счётчиками строк — им вкладка обмена и рисуется. */
  list: () => apiFetch<{ items: DirectoryInfoDto[] }>('/directories'),
  /**
   * Выгрузка книгой. Тем же порядком, что бланк путевого листа: маршрут закрыт `app.authenticate`,
   * а переход по `href` браузер делает без заголовка `Authorization` — вместо файла открылась бы
   * вкладка с 401. Имя файла портал не придумывает: сервер ставит в него дату выгрузки, а запасное
   * нужно ровно на случай, когда заголовок не доехал.
   */
  exportFile: (key: DirectoryKey, title: string) =>
    apiDownload(`/directories/${key}/export`, `${title}.xlsx`),
  /**
   * Загрузка правленого файла. `dryRun` — обязательный первый шаг: одно нажатие меняет сотни
   * строк справочника, и сначала сервер отвечает отчётом, не записав ничего.
   */
  import: (key: DirectoryKey, body: DirectoryImportBody) =>
    apiFetch<DirectoryImportReportDto>(`/directories/${key}/import`, { method: 'POST', body }),
};
