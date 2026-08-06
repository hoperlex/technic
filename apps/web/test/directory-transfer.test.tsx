import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  AuthUser,
  DirectoryImportBody,
  DirectoryImportReportDto,
  DirectoryInfoDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { DirectoryTransferTab } from '../src/pages/admin/DirectoryTransferTab';

/**
 * Обмен справочниками через файл Excel (ADR 0073).
 *
 * Проверяется не вид вкладки, а два её свойства, которые нечем восстановить, если они сломаются:
 * загрузка идёт вторым шагом и только после отчёта, а при негодных строках не идёт вовсе. Кнопка,
 * пишущая справочник сразу по выбору файла, внешне не отличалась бы ничем — а откатить правку
 * четырёхсот строк нечем.
 *
 * Шаги различает сервер по `dryRun` в теле запроса, поэтому и проверяются они по телу: «второй
 * шаг» — это второй запрос с `dryRun: false`, и перестановка файлов внутри портала этого не меняет.
 */

const DIRECTORIES: DirectoryInfoDto[] = [
  { key: 'objects', title: 'Объекты', count: 12 },
  { key: 'drivers', title: 'Водители', count: 48 },
];

const PREVIEW: DirectoryImportReportDto = {
  dryRun: true,
  key: 'objects',
  title: 'Объекты',
  totalRows: 4,
  created: [{ row: 5, title: 'ЖК Северный' }],
  updated: [
    {
      row: 3,
      title: 'ЖК Южный',
      changes: [{ column: 'Наименование', from: 'ЖК Юг', to: 'ЖК Южный' }],
    },
  ],
  unchanged: 2,
  problems: [],
  warnings: [],
};

/** Тот же файл, но сервер нашёл в нём негодные строки: применять нечего, пока их не поправят. */
const WITH_PROBLEMS: DirectoryImportReportDto = {
  ...PREVIEW,
  problems: ['строка 6: объект «» без наименования', 'строка 7: код «SEV» уже занят'],
};

/**
 * Вкладка вместе с ручками обмена. Сервер отвечает отчётом того шага, который у него спросили:
 * предпросмотр не пишет ничего, второй запрос применяет ровно показанное.
 */
function renderTab(options: { user?: AuthUser; report?: DirectoryImportReportDto } = {}) {
  const report = options.report ?? PREVIEW;
  const http = mockHttp({
    'GET /directories': () => json({ items: DIRECTORIES }),
    'POST /directories/:key/import': ({ body }) =>
      json({ ...report, dryRun: (body as DirectoryImportBody).dryRun }),
  });
  const utils = renderWithUser(<DirectoryTransferTab />, {
    user: options.user ?? authUser({ role: 'admin' }),
  });
  return { ...utils, http };
}

/** Что уехало на сервер: тела запросов загрузки по порядку отправки. */
const sent = (http: HttpMock): DirectoryImportBody[] =>
  http.calls.filter((c) => c.path.endsWith('/import')).map((c) => c.body as DirectoryImportBody);

/** Байты «книги»: заведомо не текст — .xlsx это zip, и через строку он бы не проехал. */
const BOOK_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xfe, 0x80]);

/** Выбор файла в antd Upload: скрытый input, в него кладётся книга. */
function pickFile(name = 'Объекты 2026-08-06.xlsx') {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([BOOK_BYTES], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  fireEvent.change(input, { target: { files: [file] } });
}

/** Открыть окно загрузки на строке справочника — так же, как это делает человек. */
async function openImport(title: string) {
  const row = (await screen.findByText(title)).closest('tr') as HTMLElement;
  fireEvent.click(within(row).getByText('Загрузить'));
}

describe('вкладка обмена справочниками', () => {
  it('показывает справочники со счётчиками строк', async () => {
    renderTab();

    expect(await screen.findByText('Объекты')).toBeDefined();
    expect(screen.getByText('12')).toBeDefined();
    expect(screen.getByText('Водители')).toBeDefined();
    expect(screen.getByText('48')).toBeDefined();
    // Водители — единственный справочник, файл которого уносит персональные данные.
    expect(screen.getByText('персональные данные')).toBeDefined();
  });

  it('загрузка предлагается только с правом на неё, выгрузка остаётся', async () => {
    const admin = renderTab();

    expect(await screen.findAllByText('Выгрузить')).toHaveLength(2);
    expect(screen.getAllByText('Загрузить')).toHaveLength(2);

    admin.unmount();
    // Диспетчер справочники ведёт, но менять их файлом ему не выдано (ADR 0073).
    renderTab({ user: authUser() });

    expect(await screen.findAllByText('Выгрузить')).toHaveLength(2);
    expect(screen.queryByText('Загрузить')).toBeNull();
  });

  it('по выбору файла показывает правки «было → стало» и базу при этом не трогает', async () => {
    const { http } = renderTab();

    await openImport('Объекты');
    pickFile();

    expect(await screen.findByText(/Будет заведено: 1/u)).toBeDefined();
    // Первый запрос — только предпросмотр.
    await waitFor(() => expect(sent(http).map((b) => b.dryRun)).toEqual([true]));
    expect(screen.getByText('база ещё не изменена')).toBeDefined();
    expect(screen.getByText('· строка 5 — ЖК Северный')).toBeDefined();
    expect(screen.getByText(/Будет изменено: 1/u)).toBeDefined();
    // Правка видна до знака: сверять будут именно то, что уедет взамен прежнего значения.
    expect(screen.getByText('Наименование: «ЖК Юг» → «ЖК Южный»')).toBeDefined();
    expect(screen.getByText(/Без изменений: 2/u)).toBeDefined();
  });

  /**
   * Книга едет base64 в JSON, и кодируется она байтами. Проверяется потому, что напрашивающийся
   * `btoa(await file.text())` на zip-е ломается: часть байтов не переживает чтение строкой, и
   * сервер отвечает «файл не разобран» на целую книгу.
   */
  it('файл уезжает байт в байт', async () => {
    const { http } = renderTab();

    await openImport('Объекты');
    pickFile();

    await waitFor(() => expect(sent(http)).toHaveLength(1));
    const decoded = Uint8Array.from(atob(sent(http)[0]!.contentBase64), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([...BOOK_BYTES]);
    expect(sent(http)[0]!.filename).toBe('Объекты 2026-08-06.xlsx');
  });

  it('при негодных строках применение заблокировано, а сами строки видны', async () => {
    renderTab({ report: WITH_PROBLEMS });

    await openImport('Объекты');
    pickFile();

    const apply = await screen.findByRole('button', { name: 'Применить' });
    await waitFor(() => expect(apply.hasAttribute('disabled')).toBe(true));
    expect(screen.getByText(/код «SEV» уже занят/u)).toBeDefined();
  });

  it('применение идёт вторым запросом и обновляет счётчики', async () => {
    const { http } = renderTab();

    await openImport('Объекты');
    pickFile();
    const apply = await screen.findByRole('button', { name: 'Применить' });
    await waitFor(() => expect(apply.hasAttribute('disabled')).toBe(false));
    fireEvent.click(apply);

    await waitFor(() => expect(sent(http).map((b) => b.dryRun)).toEqual([true, false]));
    // Загрузка состоялась: окно называет итог и больше не обещает, что база цела.
    expect(await screen.findByText('Заведено 1, изменено 1')).toBeDefined();
    expect(screen.queryByText('база ещё не изменена')).toBeNull();
    // Строк в справочнике стало больше — список за спиной окна перечитывается.
    await waitFor(() => expect(http.countOf('GET /directories')).toBe(2));
  });
});
