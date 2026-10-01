import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReceiptRecognitionStateDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { ReceiptRecognitionPanel } from '../src/pages/garage/ReceiptRecognitionPanel';
import { autoPartReceiptKeys } from '../src/entities/auto-part-receipt';

/**
 * Панель чтения скана в окне «Принять чек» (план `docs/auto-part-receipt-ocr-plan.md`, §10).
 *
 * Пришпилено то, за что панель отвечает и что легко потерять правкой разметки: свежий скан
 * читается САМ, прочитанное не подставляется без нажатия, а всё, что портал заметил на бумаге,
 * он говорит словами и ничего при этом не запрещает.
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
    <ReceiptRecognitionPanel fileId={FILE} formFilled={false} onApply={onApply} {...props} />,
    { user: authUser({ role: 'mechanic' }) },
  );
  return { http, onApply, ...rendered };
}

describe('панель чтения скана', () => {
  it('свежий скан читается сам, без нажатия кнопки', async () => {
    const { http } = renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () => json(state()),
      'POST /auto-part-receipts/scans/f-1/recognize': () => json(state({ status: 'pending' })),
    });

    // Uploading starts recognition without an extra click, but applying the result remains manual.
    expect(await screen.findByText(/Распознаём чек/)).toBeDefined();
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

    const progress = await screen.findByRole('progressbar', { name: 'Распознавание чека' });
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

    const progress = await screen.findByRole('progressbar', { name: 'Распознавание чека' });
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
    // Итог с бумаги против суммы подставленного — им и ловится страница, оставшаяся за кадром.
    expect(screen.getByText(/На бумаге «Итого» 30 000,00 ₽/)).toBeDefined();
    expect(screen.getByText(/таблица обрезана кадром/)).toBeDefined();
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Заполнить форму' }));
    expect(onApply).toHaveBeenCalledWith(DRAFT);
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
    // Запрета нет: пересъёмка пачки и два счёта на одном листе — законные случаи.
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
      // Панель спрашивает состояние подсистемы после любой неудачи — даже когда сервис здоров и
      // сказать про него нечего.
      'GET /auto-part-receipts/recognition/health': () =>
        json({ state: 'ok', since: null, code: '', attempts: 3, failed: 0, waiting: 0 }),
    });

    expect(await screen.findByText(/Распознать скан не удалось/)).toBeDefined();
    // Обещать восстановление там, где его нет, — тот же обман, что и молчание.
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

    // Жать «Ещё раз» на неработающем сервисе бессмысленно, и человек должен знать это сразу, а не
    // выяснять нажатиями.
    expect(await screen.findByText(/Сервис распознавания не настроен \(http_403\)/)).toBeDefined();
  });
});
