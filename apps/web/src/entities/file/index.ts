/**
 * Вложение: файл, который подшивают к заявке, путевому листу, акту ТО, чеку или показаниям.
 * Снаружи берут `@entities/file` — внутренние модули слайса не видны, и перестроить его можно, не
 * трогая потребителей.
 *
 * `api/keys.ts` в слайсе нет, и это решение, а не пропуск: сущность живёт командами, а не
 * запросами. Отдельного списка файлов портал не спрашивает ни одним экраном — вложения приходят в
 * составе своей записи (поле `files` у заявки, путевого листа, акта), и обновляет их ключ
 * владельца: после загрузки вложения путевого листа гасится `['waybills']`, а не какой-то корень
 * файлов. Заведённый «на всякий случай» корень был бы ячейкой кэша, которую никто не наполняет и
 * никто не гасит, — вторым местом, где записано то же правило, и разошлось бы оно молча.
 *
 * FOUR NAMES OUT OF `ui/FileLinks.tsx` ARE PUBLIC, and that is the whole list: a preview window, a
 * list of attachments, a button with a counter and a table cell. The row parts (`FileRef`,
 * `FileLink`, `FileDownloadButton`, `FileViewButton`, `FileListModal`) are file-local on purpose —
 * they were exported only because the file used to live outside the layers, where a public entrance
 * did not exist and `export` cost nothing. Published here they would become the slice's contract,
 * and a list of attachments assembled by hand out of the parts would no longer be the same list on
 * every screen — which is the single reason this component is shared at all.
 */
export { filesApi } from './api/filesApi';
export { FileLinkList, FilePreviewModal, FilesButton, FilesCell } from './ui/FileLinks';
