import { describe, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DriversImportReportDto } from '@technic/contracts';
import { DESKTOP_VIEWPORT, setViewport } from './viewport';

/**
 * Загрузка кадровой выгрузки (ADR 0047).
 *
 * Проверяется не вид окна, а его главное свойство: заведение живых людей идёт вторым шагом и
 * только после отчёта. Кнопка, отправляющая запись сразу по выбору файла, ничем не отличалась бы
 * внешне — а откатить заведённых двадцать восемь человек нечем.
 */

const PREVIEW: DriversImportReportDto = {
  dryRun: true,
  created: ['Иванов Иван Иванович', 'Петров Пётр Петрович'],
  skipped: ['Сидоров Сидор Сидорович'],
  withoutLicense: [{ who: 'Петров Пётр Петрович', why: 'нет ни одной известной категории' }],
  unknownCategories: [{ who: 'Иванов Иван Иванович', codes: ['am'] }],
  nameCollisions: [],
};

const DONE: DriversImportReportDto = { ...PREVIEW, dryRun: false };

const calls: { dryRun: boolean }[] = [];

vi.mock('../src/api/resources', () => ({
  driversApi: {
    import: async (body: { dryRun: boolean }) => {
      calls.push({ dryRun: body.dryRun });
      return body.dryRun ? PREVIEW : DONE;
    },
  },
}));

const { DriversImportModal } = await import('../src/pages/directories/DriversImportModal');

/** Выбор файла в antd Upload: скрытый input, в него кладётся File с содержимым выгрузки. */
function pickFile(content: string, name = 'drivers.json') {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([content], name, { type: 'application/json' });
  // jsdom не наполняет File.text() из конструктора так, как это делает браузер в jsdom@26,
  // поэтому чтение подменяется явно — компоненту важно только содержимое.
  Object.defineProperty(file, 'text', { value: async () => content });
  fireEvent.change(input, { target: { files: [file] } });
}

function renderModal(onImported = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <App>
        <DriversImportModal open onClose={vi.fn()} onImported={onImported} />
      </App>
    </QueryClientProvider>,
  );
  return { ...utils, onImported };
}

const FILE_JSON = JSON.stringify({
  drivers: [{ fullName: 'Иванов Иван Иванович', snils: '112-233-445 95' }],
});

describe('окно кадровой выгрузки', () => {
  it('по выбору файла показывает, кого заведёт, и базу при этом не трогает', async () => {
    setViewport(DESKTOP_VIEWPORT);
    calls.length = 0;
    renderModal();

    pickFile(FILE_JSON);

    expect(await screen.findByText(/Будет заведено/u)).toBeDefined();
    // Первый запрос — только предпросмотр.
    expect(calls).toEqual([{ dryRun: true }]);
    expect(screen.getByText('база ещё не изменена')).toBeDefined();
    // Отчёт называет людей поимённо: сверять будут с бумажной выгрузкой в руках.
    expect(screen.getByText('· Иванов Иван Иванович')).toBeDefined();
    expect(screen.getByText('· Сидоров Сидор Сидорович')).toBeDefined();
    // Предупреждения из отчёта видны до записи, а не после.
    expect(screen.getByText(/в отбор под машину не попадут/u)).toBeDefined();
    expect(screen.getByText(/Категорий нет в справочнике/u)).toBeDefined();
  });

  it('заведение идёт вторым шагом и обновляет справочник', async () => {
    setViewport(DESKTOP_VIEWPORT);
    calls.length = 0;
    const { onImported } = renderModal();

    pickFile(FILE_JSON);
    const submit = await screen.findByText(/Завести водителей: 2/u);
    fireEvent.click(submit);

    await waitFor(() => expect(calls).toEqual([{ dryRun: true }, { dryRun: false }]));
    // Заведение состоялось: окно перестаёт предлагать завести ещё раз и не обещает, что база цела.
    expect(await screen.findByText('Готово')).toBeDefined();
    expect(screen.queryByText('база ещё не изменена')).toBeNull();
    // Тот же итог всплывашкой и в самом окне — берём заголовок отчёта, а не первое совпадение.
    expect(document.querySelector('strong')?.textContent).toBe('Заведено водителей: 2');
    expect(onImported).toHaveBeenCalled();
  });

  it('не-JSON дальше окна не уходит: запроса нет, ошибка объяснена', async () => {
    setViewport(DESKTOP_VIEWPORT);
    calls.length = 0;
    renderModal();

    pickFile('фамилия;снилс;категории', 'выгрузка.csv');

    expect(await screen.findByText(/не JSON/u)).toBeDefined();
    expect(calls).toEqual([]);
  });
});
