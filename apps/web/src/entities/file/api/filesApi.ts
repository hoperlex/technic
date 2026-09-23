import type {
  DownloadUrlDto,
  FileDisposition,
  FileDto,
  UploadSessionDto,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

/**
 * Первый и третий шаги загрузки: сессия в хранилище и запись файла по её завершении.
 *
 * Наружу они не выставлены — их зовёт только `upload`. Снаружи эти двери означали бы ровно одно:
 * возможность пройти цикл наполовину, а чем половина кончается, сказано в шапке `filesApi` ниже.
 * Область видимости держит это надёжнее уговора.
 */
const createUploadSession = (filename: string, contentType: string, size: number) =>
  apiFetch<UploadSessionDto>('/files/upload-session', {
    method: 'POST',
    body: { filename, contentType, size },
  });

const completeUpload = (id: string) =>
  apiFetch<FileDto>(`/files/${id}/complete`, { method: 'POST' });

/**
 * Вложения портала: загрузка файла в хранилище, ссылка на него и снятие.
 *
 * Ручки общие на все модули сразу — заявки вывоза, заказа ТС, механизации и обслуживания
 * оргтехники, путевой лист, акт ТО, чек на запчасти, фото показаний. Файл везде один и тот же:
 * принадлежность задаёт не он, а запись, принявшая его идентификатор, — поэтому слайс один, а не
 * по клиенту на модуль. Девять копий цикла загрузки означали бы девять мест, где он однажды
 * разойдётся, а разойтись ему есть на чём: между presigned-ссылкой и записью файла три шага, и
 * пропустивший `complete` оставляет не вложение, а незаконченную загрузку в состоянии `pending`.
 */
export const filesApi = {
  downloadUrl: (id: string, disposition: FileDisposition = 'attachment') =>
    apiFetch<DownloadUrlDto>(`/files/${id}/download`, { query: { disposition } }),
  remove: (id: string) => apiFetch<{ ok: boolean }>(`/files/${id}`, { method: 'DELETE' }),

  /**
   * Полный цикл загрузки: session → PUT в хранилище → complete.
   *
   * Средний шаг идёт голым `fetch`, и это не небрежность: presigned-ссылка ведёт в хранилище, а не
   * в API, подпись лежит в самом URL, и заголовок `Authorization` там лишний — проведённый через
   * `apiFetch` запрос хранилище отклонит. Унификация клиента «заодно» ломает здесь загрузку молча.
   */
  async upload(file: File): Promise<FileDto> {
    const contentType = file.type || 'application/octet-stream';
    const session = await createUploadSession(file.name, contentType, file.size);
    const put = await fetch(session.uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': contentType },
    });
    if (!put.ok) throw new Error(`Ошибка загрузки в хранилище (${put.status})`);
    return completeUpload(session.fileId);
  },

  /**
   * Скачивание. Ссылка ведёт на ответ с `Content-Disposition: attachment`, поэтому переход
   * по ней сохраняет файл и не уводит со страницы — новая вкладка для этого не нужна.
   */
  async download(id: string): Promise<void> {
    const { url } = await filesApi.downloadUrl(id, 'attachment');
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
  },
};
