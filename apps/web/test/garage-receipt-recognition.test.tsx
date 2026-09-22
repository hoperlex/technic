import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReceiptRecognitionStateDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { ReceiptRecognitionPanel } from '../src/pages/garage/ReceiptRecognitionPanel';

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
  renderWithUser(
    <ReceiptRecognitionPanel fileId={FILE} formFilled={false} onApply={onApply} {...props} />,
    { user: authUser({ role: 'mechanic' }) },
  );
  return { http, onApply };
}

describe('панель чтения скана', () => {
  it('свежий скан читается сам, без нажатия кнопки', async () => {
    const { http } = renderPanel({
      'GET /auto-part-receipts/scans/f-1/recognition': () => json(state()),
      'POST /auto-part-receipts/scans/f-1/recognize': () => json(state({ status: 'pending' })),
    });

    // Ради этого панель и существует: механик кладёт скан и видит, что его уже читают.
    expect(await screen.findByText(/Скан распознаётся/)).toBeDefined();
    await waitFor(() =>
      expect(http.countOf('POST /auto-part-receipts/scans/f-1/recognize')).toBe(1),
    );
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
