import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReceiptRecognitionStateDto } from '@technic/contracts';
import { apiError, json, mockHttp, type MockResponse } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { ReceiptRecognitionPanel } from '../src/pages/garage/ReceiptRecognitionPanel';
import { ReceiptScanField, type ScanFile } from '../src/pages/garage/ReceiptScanField';
import { autoPartReceiptKeys } from '../src/entities/auto-part-receipt';

/**
 * Recognition starts automatically, but applying its draft remains the user's choice.
 * Every state shares one neutral shell; JSDOM can verify its identity and content, not its height.
 */

const FILE = 'f-1';

function state(over: Partial<ReceiptRecognitionStateDto> = {}): ReceiptRecognitionStateDto {
  return {
    fileId: FILE,
    status: 'idle',
    queuedAt: null,
    delayed: false,
    totalPages: 0,
    processedPages: 0,
    draft: null,
    errorClass: null,
    errorScope: null,
    message: '',
    duplicate: null,
    ...over,
  };
}

const DRAFT = {
  header: {
    documentNumber: '6468',
    purchasedOn: '2026-09-08',
    purchasedOnRaw: '8 сентября 2026 г.',
    purchasedOnIssue: '',
    sellerName: 'ООО "МС-партс"',
  },
  lines: [
    {
      article: 'УТ-00010050',
      name: 'Стекло для двери Bobcat',
      quantity: 1,
      quantityRaw: '1',
      unit: 'шт',
      amount: 18900,
      kind: 'part' as const,
      issues: [],
    },
  ],
  notes: {
    linesTotal: 30000,
    documentTotal: 30000,
    draftTotal: 18900,
    linesTruncated: true,
    recognizedLines: 1,
    droppedLines: 0,
  },
};

function renderPanel(
  responses: Parameters<typeof mockHttp>[0],
  props: Partial<Parameters<typeof ReceiptRecognitionPanel>[0]> = {},
) {
  const http = mockHttp(responses);
  const onApply = vi.fn();
  const rendered = renderWithUser(
    <ReceiptRecognitionPanel
      files={[{ id: FILE, filename: 'first.jpg' }]}
      formFilled={false}
      onApply={onApply}
      {...props}
    />,
    { user: authUser({ role: 'mechanic' }) },
  );
  return { http, onApply, ...rendered };
}

function minimalPanel(): HTMLElement {
  const panel = screen.getByRole('region', { name: 'Распознавание скана чека' });
  expect(panel.classList.contains('receipt-recognition-panel')).toBe(true);
  expect(panel.querySelector('.receipt-recognition-panel__body')).not.toBeNull();
  expect(panel.querySelector('.receipt-recognition-panel__actions')).not.toBeNull();
  expect(document.querySelector('.ant-alert')).toBeNull();
  return panel;
}

function deferredResponse() {
  let resolve!: (response: MockResponse) => void;
  const promise = new Promise<MockResponse>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('панель чтения скана', () => {
  it('сохраняет оболочку без скана, при загрузке состояния и во время распознавания', async () => {
    const initialRead = deferredResponse();
    const http = mockHttp({
      'GET /auto-part-receipts/scans/f-1/recognition': () => initialRead.promise,
    });
    function UploadScenario() {
      const [files, setFiles] = useState<{ id: string; filename: string }[]>([]);
      return (
        <>
          <button onClick={() => setFiles([{ id: FILE, filename: 'first.jpg' }])}>
            Добавить скан для теста
          </button>
          <ReceiptRecognitionPanel files={files} formFilled={false} onApply={vi.fn()} />
        </>
      );
    }
    renderWithUser(<UploadScenario />, { user: authUser({ role: 'mechanic' }) });

    const panel = minimalPanel();
    expect(http.calls).toHaveLength(0);
    expect(screen.queryByRole('progressbar')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Добавить скан для теста' }));
    await waitFor(() => expect(http.calls).toHaveLength(1));
    expect(minimalPanel()).toBe(panel);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();

    await act(async () => {
      initialRead.resolve(json(state({ status: 'pending', totalPages: 1 })));
    });
    expect(await screen.findByText(/Успешно прочитано страниц: 0 из 1/)).toBeDefined();
    expect(screen.getByRole('progressbar', { name: 'Распознавание чека' })).toBeDefined();
    expect(minimalPanel()).toBe(panel);
  });

  it('свежий скан читается сам, без нажатия кнопки', async () => {
    const { http } = renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () => json(state()),
      'POST /auto-part-receipts/scans/f-1/recognize': () => json(state({ status: 'pending' })),
    });

    // Uploading starts recognition without an extra click, but applying the result remains manual.
    expect(await screen.findByText(/Распознаём чек/)).toBeDefined();
    minimalPanel();
    expect(screen.queryByRole('alert')).toBeNull();
    const progress = screen.getByRole('progressbar', { name: 'Распознавание чека' });
    expect(progress.getAttribute('aria-valuenow')).toBeNull();
    expect(progress.getAttribute('aria-valuetext')).toContain('Файл ожидает очереди');
    expect(screen.getByText(/ориентир — 20–30 секунд на страницу, иногда дольше/)).toBeDefined();
    expect(http.countOf('GET /auto-part-receipts/recognition/health')).toBe(0);
    await waitFor(() =>
      expect(http.countOf('POST /auto-part-receipts/scans/f-1/recognize')).toBe(1),
    );
  });

  it('не выдумывает процент, пока не прочитана первая страница', async () => {
    renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(state({ status: 'pending', totalPages: 1, processedPages: 0 })),
    });

    expect(await screen.findByText(/Успешно прочитано страниц: 0 из 1/)).toBeDefined();
    const progress = screen.getByRole('progressbar', { name: 'Распознавание чека' });
    minimalPanel();
    expect(progress.getAttribute('aria-valuenow')).toBeNull();
    expect(progress.getAttribute('aria-valuemax')).toBe('1');
    expect(screen.getByText(/Успешно прочитано страниц: 0 из 1/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('показывает фактический прогресс по страницам и убирает ожидание после результата', async () => {
    const { queryClient, container, onApply } = renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(state({ status: 'pending', totalPages: 4, processedPages: 1 })),
    });

    await screen.findByText(/Успешно прочитано страниц: 1 из 4/);
    const progress = screen.getByRole('progressbar', { name: 'Распознавание чека' });
    const panel = minimalPanel();
    expect(progress.getAttribute('aria-valuenow')).toBe('1');
    expect(progress.getAttribute('aria-valuemax')).toBe('4');
    expect(progress.getAttribute('aria-valuetext')).toBe('Успешно прочитано страниц: 1 из 4');
    expect((progress.firstElementChild as HTMLElement).style.width).toBe('25%');

    await act(async () => {
      queryClient.setQueryData(
        autoPartReceiptKeys.recognition(FILE),
        state({ status: 'done', totalPages: 4, processedPages: 4, draft: DRAFT }),
      );
    });

    expect(await screen.findByText(/Распознано позиций: 1/)).toBeDefined();
    expect(minimalPanel()).toBe(panel);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/Подождите немного/)).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('после пятнадцати минут показывает задержку, прогресс и безопасный reload', async () => {
    renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(
          state({
            status: 'pending',
            queuedAt: '2026-09-30T10:00:00.000Z',
            delayed: true,
            totalPages: 3,
            processedPages: 1,
          }),
        ),
      'GET /auto-part-receipts/recognition/health': () =>
        json({
          state: 'degraded',
          since: '2026-09-30T10:00:00.000Z',
          code: '',
          attempts: 5,
          failed: 4,
          waiting: 1,
        }),
    });

    expect(await screen.findByText(/Распознавание задержалось/)).toBeDefined();
    minimalPanel();
    expect(screen.getByText(/Успешно прочитано страниц: 1 из 3/)).toBeDefined();
    expect(screen.getByText(/черновик и сканы восстановятся/)).toBeDefined();
    expect(await screen.findByText(/Сервис распознавания сейчас недоступен/)).toBeDefined();
    expect(screen.queryByText(/ориентир — 20–30 секунд/)).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('прочитанное не подставляется само: форму заполняет нажатие', async () => {
    const { onApply } = renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(state({ status: 'done', totalPages: 2, processedPages: 2, draft: DRAFT })),
    });

    expect(await screen.findByText(/Распознано позиций: 1/)).toBeDefined();
    const panel = minimalPanel();
    // Comparing the paper's total with extracted lines can reveal missing rows or pages.
    expect(screen.getByText(/На бумаге «Итого» 30 000,00 ₽/)).toBeDefined();
    expect(screen.getByText(/таблица обрезана кадром/)).toBeDefined();
    expect(onApply).not.toHaveBeenCalled();
    expect(
      panel
        .querySelector('.receipt-recognition-panel__actions')
        ?.contains(screen.getByRole('button', { name: 'Заполнить форму' })),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Заполнить форму' }));
    expect(onApply).toHaveBeenCalledWith(DRAFT, [FILE], 'replace');
  });

  it('собирает несколько файлов одного чека в один черновик по порядку листов', async () => {
    const second = {
      ...DRAFT,
      header: { ...DRAFT.header, documentNumber: '', sellerName: '' },
      lines: [{ ...DRAFT.lines[0]!, article: 'SECOND', name: 'Фильтр', amount: 1100 }],
      notes: { ...DRAFT.notes, linesTotal: 20000, documentTotal: 20000, draftTotal: 1100 },
    };
    const { onApply } = renderPanel(
      {
        'GET /auto-part-receipts/scans/f-1/recognition': () =>
          json(state({ status: 'done', draft: DRAFT })),
        'GET /auto-part-receipts/scans/f-2/recognition': () =>
          json(state({ fileId: 'f-2', status: 'done', draft: second })),
      },
      {
        files: [
          { id: FILE, filename: 'first.jpg' },
          { id: 'f-2', filename: 'second.jpg' },
        ],
      },
    );

    expect(await screen.findByText('Распознано позиций: 2')).toBeDefined();
    expect(screen.getByText('Распознано файлов: 2 из 2')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Заполнить форму' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const [draft, ids, mode] = onApply.mock.calls[0]!;
    expect(ids).toEqual(['f-1', 'f-2']);
    expect(mode).toBe('replace');
    expect(draft.lines.map((line: { article: string }) => line.article)).toEqual([
      'УТ-00010050',
      'SECOND',
    ]);
    expect(draft.header.documentNumber).toBe('6468');
    expect(draft.notes.linesTotal).toBe(20000);
  });

  it('сохраняет порядок выбора файлов, даже когда второй загрузился раньше первого', async () => {
    const firstComplete = deferredResponse();
    const secondComplete = deferredResponse();
    const http = mockHttp({
      'POST /files/upload-session': ({ body }) => {
        const name = (body as { filename: string }).filename;
        return json({
          fileId: name === 'first.jpg' ? 'f-1' : 'f-2',
          uploadUrl: 'https://storage.test/put',
          objectKey: name,
          expiresIn: 60,
        });
      },
      'POST /files/f-1/complete': () => firstComplete.promise,
      'POST /files/f-2/complete': () => secondComplete.promise,
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(state({ status: 'done', draft: DRAFT })),
      'GET /auto-part-receipts/scans/f-2/recognition': () =>
        json(state({ fileId: 'f-2', status: 'done', draft: DRAFT })),
    });
    const onApply = vi.fn();
    function UploadScenario() {
      const [files, setFiles] = useState<ScanFile[]>([]);
      return (
        <ReceiptScanField
          files={files}
          onChange={setFiles}
          onError={vi.fn()}
          disabled={false}
          formFilled={false}
          lineCount={0}
          appliedFileIds={[]}
          onApplyDraft={onApply}
          onResetApplied={vi.fn()}
          onUploadCountChange={vi.fn()}
        />
      );
    }
    const { container } = renderWithUser(<UploadScenario />, {
      user: authUser({ role: 'mechanic' }),
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(['first'], 'first.jpg', { type: 'image/jpeg' }),
          new File(['second'], 'second.jpg', { type: 'image/jpeg' }),
        ],
      },
    });
    await waitFor(() => expect(http.countOf('POST /files/f-2/complete')).toBe(1));
    await act(async () => {
      secondComplete.resolve(json({ id: 'f-2', filename: 'second.jpg', size: 6 }));
    });
    expect(screen.queryByRole('button', { name: 'Заполнить форму' })).toBeNull();
    await act(async () => {
      firstComplete.resolve(json({ id: 'f-1', filename: 'first.jpg', size: 5 }));
    });
    const apply = await screen.findByRole('button', { name: 'Заполнить форму' });
    expect(
      [...container.querySelectorAll('.ant-list-items > .ant-list-item')].map(
        (item) => item.querySelector('a')?.textContent,
      ),
    ).toEqual(['first.jpg', 'second.jpg']);
    fireEvent.click(apply);
    expect(onApply.mock.calls[0]?.[1]).toEqual(['f-1', 'f-2']);
  });

  it('после переноса первого листа предлагает добавить только строки нового, без замены правок', async () => {
    const second = {
      ...DRAFT,
      lines: [{ ...DRAFT.lines[0]!, article: 'SECOND', name: 'Фильтр' }],
    };
    const { onApply } = renderPanel(
      {
        'GET /auto-part-receipts/scans/f-1/recognition': () =>
          json(state({ status: 'done', draft: DRAFT })),
        'GET /auto-part-receipts/scans/f-2/recognition': () =>
          json(state({ fileId: 'f-2', status: 'done', draft: second })),
      },
      {
        files: [
          { id: FILE, filename: 'first.jpg' },
          { id: 'f-2', filename: 'second.jpg' },
        ],
        appliedFileIds: ['f-1'],
        lineCount: 1,
        formFilled: true,
      },
    );
    const confirm = vi.spyOn(window, 'confirm');
    try {
      const append = await screen.findByRole('button', { name: 'Добавить новые строки' });
      expect(screen.getByText('Новых позиций: 1')).toBeDefined();
      fireEvent.click(append);
      expect(confirm).not.toHaveBeenCalled();
      expect(onApply).toHaveBeenCalledExactlyOnceWith(second, ['f-2'], 'append');
    } finally {
      confirm.mockRestore();
    }
  });

  it('при отказе одного файла сохраняет черновик другого и называет проблемный лист', async () => {
    const { onApply } = renderPanel(
      {
        'GET /auto-part-receipts/scans/f-1/recognition': () =>
          json(state({ status: 'done', draft: DRAFT })),
        'GET /auto-part-receipts/scans/f-2/recognition': () =>
          json(state({ fileId: 'f-2', status: 'failed', message: 'Не читается' })),
        'GET /auto-part-receipts/recognition/health': () =>
          json({ state: 'ok', since: null, code: '', attempts: 2, failed: 1, waiting: 0 }),
      },
      {
        files: [
          { id: FILE, filename: 'first.jpg' },
          { id: 'f-2', filename: 'second.jpg' },
        ],
      },
    );
    expect(await screen.findByText('Распознано позиций: 1')).toBeDefined();
    expect(screen.getByText('second.jpg: Не читается')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Повторить сбой' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Заполнить форму' }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith(DRAFT, ['f-1'], 'replace');
  });

  it('не добавляет новый лист, если он превысит предел строк чека', async () => {
    const { onApply } = renderPanel(
      {
        'GET /auto-part-receipts/scans/f-1/recognition': () =>
          json(state({ status: 'done', draft: DRAFT })),
        'GET /auto-part-receipts/scans/f-2/recognition': () =>
          json(state({ fileId: 'f-2', status: 'done', draft: DRAFT })),
      },
      {
        files: [
          { id: FILE, filename: 'first.jpg' },
          { id: 'f-2', filename: 'second.jpg' },
        ],
        appliedFileIds: ['f-1'],
        lineCount: 100,
      },
    );
    const append = await screen.findByRole('button', { name: 'Добавить новые строки' });
    expect((append as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Новые позиции не поместятся в один чек/)).toBeDefined();
    fireEvent.click(append);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('скан, уже подшитый к другому чеку, — предупреждение, и только (Р12)', async () => {
    renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(
          state({
            status: 'done',
            draft: DRAFT,
            duplicate: {
              receiptId: 'r-9',
              documentNumber: '1138',
              purchasedOn: '2026-08-25',
              visible: true,
            },
          }),
        ),
    });

    expect(await screen.findByText(/уже подшит к чеку № 1138/)).toBeDefined();
    minimalPanel();
    // A rescan or two invoices on one page can be legitimate, so a duplicate stays advisory.
    expect(screen.getByRole('button', { name: 'Заполнить форму' })).toBeDefined();
  });

  it('терминальный отказ не обещает автоматического повтора', async () => {
    renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(
          state({
            status: 'failed',
            errorClass: 'terminal',
            errorScope: 'subsystem',
            message: 'Отказ доступа к сервису распознавания.',
          }),
        ),
      // Health is queried after every failure, including file-specific failures of a healthy service.
      'GET /auto-part-receipts/recognition/health': () =>
        json({ state: 'ok', since: null, code: '', attempts: 3, failed: 0, waiting: 0 }),
    });

    expect(await screen.findByText(/Распознать скан не удалось/)).toBeDefined();
    minimalPanel();
    // A terminal failure must not promise recovery that the queue will never attempt.
    expect(screen.getByText(/Автоматического повтора не будет/)).toBeDefined();
  });

  it('отказ объясняется состоянием сервиса, когда сервис и правда болен (§11)', async () => {
    renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(
          state({
            status: 'failed',
            errorClass: 'terminal',
            errorScope: 'subsystem',
            message: 'Отказ доступа.',
          }),
        ),
      'GET /auto-part-receipts/recognition/health': () =>
        json({
          state: 'unconfigured',
          since: '2026-09-21T10:00:00.000Z',
          code: 'http_403',
          attempts: 4,
          failed: 4,
          waiting: 0,
        }),
    });

    // Retrying a misconfigured service cannot repair it; the explanation must remain visible.
    expect(await screen.findByText(/Сервис распознавания не настроен \(http_403\)/)).toBeDefined();
    minimalPanel();
  });

  it.each([
    {
      name: 'окончательный отказ',
      result: state({ status: 'failed', errorClass: 'terminal', message: 'Страница не читается.' }),
      text: /Распознать скан не удалось/,
    },
    {
      name: 'неподдерживаемый файл',
      result: state({ status: 'unsupported', message: 'Поддерживаются изображения и PDF.' }),
      text: /Это не изображение и не PDF/,
    },
    {
      name: 'успех с предупреждением о дубле',
      result: state({
        status: 'done',
        draft: DRAFT,
        duplicate: {
          receiptId: 'r-9',
          documentNumber: '1138',
          purchasedOn: '2026-08-25',
          visible: true,
        },
      }),
      text: /уже подшит к чеку № 1138/,
    },
  ])('pending → $name не заменяет общую оболочку цветной плашкой', async ({ result, text }) => {
    const { queryClient } = renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(state({ status: 'pending', totalPages: 1 })),
      'GET /auto-part-receipts/recognition/health': () =>
        json({ state: 'ok', since: null, code: '', attempts: 1, failed: 0, waiting: 0 }),
    });
    await screen.findByText(/Успешно прочитано страниц: 0 из 1/);
    const panel = minimalPanel();

    await act(async () => {
      queryClient.setQueryData(autoPartReceiptKeys.recognition(FILE), result);
    });

    expect(await screen.findByText(text)).toBeDefined();
    expect(minimalPanel()).toBe(panel);
    expect(screen.queryByRole('progressbar')).toBeNull();
    if (result.status === 'unsupported') {
      expect(screen.getByText(result.message)).toBeDefined();
      expect(panel.querySelector('button')).toBeNull();
    }
  });

  it('оставляет все предупреждения о распознанных строках внутри нейтральной панели', async () => {
    renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(
          state({
            status: 'done',
            totalPages: 3,
            processedPages: 1,
            draft: {
              ...DRAFT,
              notes: {
                ...DRAFT.notes,
                documentTotal: 36000,
                recognizedLines: 105,
                droppedLines: 5,
              },
            },
          }),
        ),
    });

    expect(
      await screen.findByText(/Распознано 105 позиций, в один чек помещается 100/),
    ).toBeDefined();
    expect(screen.getByText(/На бумаге «Итого» 30 000,00 ₽/)).toBeDefined();
    expect(screen.getByText(/НДС начислен сверх таблицы/)).toBeDefined();
    expect(screen.getByText(/В файле страниц: 3, прочитано: 1/)).toBeDefined();
    const panel = minimalPanel();
    expect(
      panel
        .querySelector('.receipt-recognition-panel__body')
        ?.contains(screen.getByText(/НДС начислен сверх таблицы/)),
    ).toBe(true);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('не заменяет заполненную форму без подтверждения', async () => {
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    try {
      const { onApply } = renderPanel(
        {
          'GET /auto-part-receipts/scans/f-1/recognition': () =>
            json(state({ status: 'done', draft: DRAFT })),
        },
        { formFilled: true },
      );
      const apply = await screen.findByRole('button', { name: 'Заполнить форму' });

      fireEvent.click(apply);
      expect(confirm).toHaveBeenCalledWith('Заменить набранное распознанным (1 строк)?');
      expect(onApply).not.toHaveBeenCalled();

      fireEvent.click(apply);
      expect(onApply).toHaveBeenCalledExactlyOnceWith(DRAFT, [FILE], 'replace');
      minimalPanel();
    } finally {
      confirm.mockRestore();
    }
  });

  it.each([
    {
      name: 'успешного результата',
      initial: state({
        status: 'done',
        totalPages: 2,
        processedPages: 2,
        draft: DRAFT,
        duplicate: {
          receiptId: 'r-9',
          documentNumber: '1138',
          purchasedOn: '2026-08-25',
          visible: true,
        },
      }),
      retryName: 'Распознать заново',
    },
    {
      name: 'отказа',
      initial: state({
        status: 'failed',
        errorClass: 'transient',
        message: 'Временный сбой распознавания.',
      }),
      retryName: 'Ещё раз',
    },
  ])('повтор после $name сразу скрывает старое содержимое', async ({ initial, retryName }) => {
    const queued = deferredResponse();
    const { http, onApply } = renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () => json(initial),
      'GET /auto-part-receipts/recognition/health': () =>
        json({ state: 'ok', since: null, code: '', attempts: 1, failed: 0, waiting: 0 }),
      'POST /auto-part-receipts/scans/f-1/recognize': () => queued.promise,
    });
    const retry = await screen.findByRole('button', { name: retryName });
    const panel = minimalPanel();
    if (initial.status === 'failed') {
      expect(screen.getByText(/Можно попробовать ещё раз/)).toBeDefined();
    }

    fireEvent.click(retry);

    await screen.findByRole('progressbar');
    expect(minimalPanel()).toBe(panel);
    expect(screen.queryByText(/Распознано позиций/)).toBeNull();
    expect(screen.queryByText(/На бумаге «Итого»/)).toBeNull();
    expect(screen.queryByText(/уже подшит к чеку/)).toBeNull();
    expect(screen.queryByText(/Распознать скан не удалось/)).toBeNull();
    expect(screen.queryByText(/Временный сбой распознавания/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Заполнить форму' })).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();
    await waitFor(() =>
      expect(http.countOf('POST /auto-part-receipts/scans/f-1/recognize')).toBe(1),
    );
    expect(http.lastCall('POST /auto-part-receipts/scans/f-1/recognize')?.body).toEqual({
      forced: true,
    });
    expect(onApply).not.toHaveBeenCalled();

    await act(async () => {
      queued.resolve(json(state({ status: 'pending' })));
    });
    expect(minimalPanel()).toBe(panel);
    expect(screen.getByRole('progressbar')).toBeDefined();
  });

  it.each(['done', 'failed'] as const)('disabled блокирует кнопки состояния %s', async (status) => {
    const { http, onApply } = renderPanel(
      {
        'GET /auto-part-receipts/scans/f-1/recognition': () =>
          json(state({ status, draft: status === 'done' ? DRAFT : null })),
        'GET /auto-part-receipts/recognition/health': () =>
          json({ state: 'ok', since: null, code: '', attempts: 1, failed: 0, waiting: 0 }),
      },
      { disabled: true },
    );
    const retry = await screen.findByRole('button', {
      name: status === 'done' ? 'Распознать заново' : 'Ещё раз',
    });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retry);
    if (status === 'done') {
      const apply = screen.getByRole('button', { name: 'Заполнить форму' });
      expect((apply as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(apply);
    }
    expect(http.countOf('POST /auto-part-receipts/scans/f-1/recognize')).toBe(0);
    expect(onApply).not.toHaveBeenCalled();
    minimalPanel();
  });

  it.each(['pending', 'failed'] as const)(
    'POST первого скана в состоянии %s не скрывает результат второго скана',
    async (firstRequest) => {
      const queuedFirst = deferredResponse();
      const secondDraft = {
        ...DRAFT,
        lines: [...DRAFT.lines, { ...DRAFT.lines[0]!, article: 'SECOND', name: 'Фильтр' }],
      };
      const http = mockHttp({
        'GET /auto-part-receipts/scans/f-1/recognition': () => json(state()),
        'POST /auto-part-receipts/scans/f-1/recognize': () => queuedFirst.promise,
        'GET /auto-part-receipts/scans/f-2/recognition': () =>
          json(state({ fileId: 'f-2', status: 'done', draft: secondDraft })),
      });
      const onApply = vi.fn();
      function SwitchScanScenario() {
        const [fileId, setFileId] = useState(FILE);
        return (
          <>
            <button onClick={() => setFileId('f-2')}>Показать второй скан</button>
            <ReceiptRecognitionPanel
              files={[{ id: fileId, filename: 'scan.jpg' }]}
              formFilled={false}
              onApply={onApply}
            />
          </>
        );
      }
      renderWithUser(<SwitchScanScenario />, { user: authUser({ role: 'mechanic' }) });
      await waitFor(() =>
        expect(http.countOf('POST /auto-part-receipts/scans/f-1/recognize')).toBe(1),
      );
      const panel = minimalPanel();

      if (firstRequest === 'failed') {
        await act(async () => {
          queuedFirst.resolve(
            apiError(500, {
              code: 'recognition_unavailable',
              message: 'Сбой запуска первого скана.',
            }),
          );
        });
        expect(
          await screen.findByText('Не удалось получить результат распознавания'),
        ).toBeDefined();
        expect(screen.getByRole('button', { name: 'Ещё раз' })).toBeDefined();
      }

      fireEvent.click(screen.getByRole('button', { name: 'Показать второй скан' }));
      expect(await screen.findByText('Распознано позиций: 2')).toBeDefined();
      expect(minimalPanel()).toBe(panel);
      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(screen.queryByText('Не удалось получить результат распознавания')).toBeNull();
      expect(screen.queryByText('Сбой запуска первого скана.')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Ещё раз' })).toBeNull();

      if (firstRequest === 'pending') {
        // The late response still belongs to the first scan; it must not replace the visible draft.
        await act(async () => {
          queuedFirst.resolve(json(state({ status: 'done', draft: DRAFT })));
        });
        expect(screen.getByText('Распознано позиций: 2')).toBeDefined();
        expect(screen.queryByText('Распознано позиций: 1')).toBeNull();
      }

      fireEvent.click(screen.getByRole('button', { name: 'Заполнить форму' }));
      expect(onApply).toHaveBeenCalledExactlyOnceWith(secondDraft, ['f-2'], 'replace');
      expect(http.countOf('POST /auto-part-receipts/scans/f-2/recognize')).toBe(0);
    },
  );

  it('после ошибки загрузки состояния перечитывает GET без нового запуска распознавания', async () => {
    const { http } = renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        apiError(500, {
          code: 'recognition_state_unavailable',
          message: 'Состояние временно недоступно.',
        }),
    });
    expect(await screen.findByText('Не удалось получить результат распознавания')).toBeDefined();
    const panel = minimalPanel();
    expect(screen.queryByRole('progressbar')).toBeNull();
    http.use({
      'GET /auto-part-receipts/scans/f-1/recognition': () =>
        json(state({ status: 'done', draft: DRAFT })),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Ещё раз' }));

    expect(await screen.findByText('Распознано позиций: 1')).toBeDefined();
    expect(minimalPanel()).toBe(panel);
    expect(screen.queryByText('Не удалось получить результат распознавания')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Заполнить форму' })).toBeDefined();
    expect(http.countOf('GET /auto-part-receipts/scans/f-1/recognition')).toBe(2);
    expect(http.countOf('POST /auto-part-receipts/scans/f-1/recognize')).toBe(0);
  });
});
