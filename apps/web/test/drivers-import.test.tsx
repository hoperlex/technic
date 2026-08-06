import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { DriversImportBody, DriversImportReportDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { DriversImportModal } from '../src/pages/directories/DriversImportModal';

/**
 * Загрузка кадровой выгрузки (ADR 0047).
 *
 * Проверяется не вид окна, а его главное свойство: заведение живых людей идёт вторым шагом и
 * только после отчёта. Кнопка, отправляющая запись сразу по выбору файла, ничем не отличалась бы
 * внешне — а откатить заведённых двадцать восемь человек нечем.
 *
 * Шаги различает сервер по `dryRun` в теле запроса, поэтому и проверяются они по телу запроса, а
 * не по подменённому модулю портала: «второй шаг» — это второй запрос с `dryRun: false`, и
 * никакая перестановка файлов внутри портала этого не меняет.
 */

const PREVIEW: DriversImportReportDto = {
  dryRun: true,
  created: ['Иванов Иван Иванович', 'Петров Пётр Петрович'],
  skipped: ['Сидоров Сидор Сидорович'],
  emailUpdated: [{ who: 'Сидоров Сидор Сидорович', email: 'sidorov@example.ru' }],
  withoutLicense: [{ who: 'Петров Пётр Петрович', why: 'нет ни одной известной категории' }],
  unknownCategories: [{ who: 'Иванов Иван Иванович', codes: ['am'] }],
  nameCollisions: [],
};

const DONE: DriversImportReportDto = { ...PREVIEW, dryRun: false };

/** Выбор файла в antd Upload: скрытый input, в него кладётся File с содержимым выгрузки. */
function pickFile(content: string, name = 'drivers.json') {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([content], name, { type: 'application/json' });
  // jsdom не наполняет File.text() из конструктора так, как это делает браузер в jsdom@26,
  // поэтому чтение подменяется явно — компоненту важно только содержимое.
  Object.defineProperty(file, 'text', { value: async () => content });
  fireEvent.change(input, { target: { files: [file] } });
}

/**
 * Окно вместе с ручкой наполнения. Сервер отвечает отчётом того шага, который у него спросили:
 * предпросмотр не записывает ничего, второй запрос заводит ровно показанное.
 */
function renderModal(onImported = vi.fn()) {
  const http = mockHttp({
    'POST /drivers/import': ({ body }) => json((body as DriversImportBody).dryRun ? PREVIEW : DONE),
  });
  const utils = renderWithUser(
    <DriversImportModal open onClose={vi.fn()} onImported={onImported} />,
  );
  return { ...utils, http, onImported };
}

/** Что уехало на сервер: тела запросов наполнения по порядку отправки. */
const sent = (http: HttpMock): DriversImportBody[] =>
  http.calls.filter((c) => c.path === '/drivers/import').map((c) => c.body as DriversImportBody);

const FILE_JSON = JSON.stringify({
  drivers: [{ fullName: 'Иванов Иван Иванович', snils: '112-233-445 95' }],
});

describe('окно кадровой выгрузки', () => {
  it('по выбору файла показывает, кого заведёт, и базу при этом не трогает', async () => {
    const { http } = renderModal();

    pickFile(FILE_JSON);

    expect(await screen.findByText(/Будет заведено/u)).toBeDefined();
    // Первый запрос — только предпросмотр.
    expect(sent(http).map((b) => b.dryRun)).toEqual([true]);
    expect(screen.getByText('база ещё не изменена')).toBeDefined();
    // Отчёт называет людей поимённо: сверять будут с бумажной выгрузкой в руках.
    expect(screen.getByText('· Иванов Иван Иванович')).toBeDefined();
    expect(screen.getByText('· Сидоров Сидор Сидорович')).toBeDefined();
    // Предупреждения из отчёта видны до записи, а не после.
    expect(screen.getByText(/в отбор под машину не попадут/u)).toBeDefined();
    expect(screen.getByText(/Категорий нет в справочнике/u)).toBeDefined();
  });

  it('заведение идёт вторым шагом и обновляет справочник', async () => {
    const { http, onImported } = renderModal();

    pickFile(FILE_JSON);
    const submit = await screen.findByText(/Завести водителей: 2/u);
    fireEvent.click(submit);

    await waitFor(() => expect(sent(http).map((b) => b.dryRun)).toEqual([true, false]));
    // Заведение состоялось: окно перестаёт предлагать завести ещё раз и не обещает, что база цела.
    expect(await screen.findByText('Готово')).toBeDefined();
    expect(screen.queryByText('база ещё не изменена')).toBeNull();
    // Тот же итог всплывашкой и в самом окне — берём заголовок отчёта, а не первое совпадение.
    expect(document.querySelector('strong')?.textContent).toBe('Заведено водителей: 2');
    expect(onImported).toHaveBeenCalled();
  });

  /**
   * Оба запроса несут саму выгрузку. Проверяется потому, что окно уходило в предпросмотр тем же
   * обработчиком, что разобрал файл: состояние к этому моменту ещё не закоммичено, и запрос уносил
   * `file` предыдущего рендера — `null`. Внешне это неотличимо от негодного файла: сервер отвечает
   * «Ошибка валидации данных: file», и человек ищет ошибку в выгрузке, которая цела.
   */
  it('в оба запроса уходит разобранная выгрузка, а не пустое поле', async () => {
    const { http } = renderModal();

    pickFile(FILE_JSON);
    fireEvent.click(await screen.findByText(/Завести водителей: 2/u));

    await waitFor(() => expect(sent(http)).toHaveLength(2));
    expect(sent(http)[0]!.file).toEqual(JSON.parse(FILE_JSON));
    expect(sent(http)[1]!.file).toEqual(JSON.parse(FILE_JSON));
  });

  it('не-JSON дальше окна не уходит: запроса нет, ошибка объяснена', async () => {
    const { http } = renderModal();

    pickFile('фамилия;снилс;категории', 'выгрузка.csv');

    expect(await screen.findByText(/не JSON/u)).toBeDefined();
    expect(http.countOf('POST /drivers/import')).toBe(0);
  });
});
