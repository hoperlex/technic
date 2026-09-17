import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { WasteTicketBadgeDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { wasteRequest } from './factories/waste';
import { TicketCell } from '../src/features/waste-ticket-review';
import { WasteRequestViewModal } from '../src/pages/waste/WasteRequestViewModal';

/**
 * Крестик колонки «Талоны» и его подсказка (ADR 0195).
 *
 * Разбивка из пяти значков была верна и бесполезна: сделать с нею в строке списка нечего, а
 * разбирать всё равно идут в карточку. Проверяется поэтому не «нарисовалось», а три вещи, которые
 * колонка обещает: ход на разбор существует и ведёт на ту заявку, которую человек видел; числа не
 * потерялись, а переехали в подсказку с расшифровкой; и границы, которых крестик не касается, —
 * разобранная заявка и заявка, готовая к подтверждению одним кликом.
 */

/** Заявка с поводом для разбора: расхождение, законное предупреждение и очередь на подтверждение. */
const MIXED: WasteTicketBadgeDto = {
  errors: 1,
  warnings: 1,
  pendingConfirmation: 2,
  failures: 0,
  unreviewedPaper: 0,
  confirmable: 0,
  confirmableFingerprint: '',
};

const REVIEW_BUTTON = /^Открыть разбор талонов/u;

const badgedRequest = (badge: WasteTicketBadgeDto = MIXED) =>
  wasteRequest({ status: 'done', ticketBadge: badge });

describe('крестик колонки «Талоны» ведёт на разбор', () => {
  it('на месте разбивки значков стоит одна кнопка', () => {
    mockHttp({});
    const { container } = renderWithUser(
      <TicketCell request={badgedRequest()} onReview={() => {}} />,
    );

    expect(screen.getByRole('button', { name: REVIEW_BUTTON })).toBeDefined();
    // Значков в самой ячейке нет: ради этого места колонку и переделывали — числа читают в
    // подсказке, а в строке остаётся ход, которым разбор начинают.
    expect(container.textContent).not.toContain('⛔');
    expect(container.textContent).not.toContain('⏳');
  });

  it('подсказка называет только то, что за заявкой числится', async () => {
    mockHttp({});
    renderWithUser(<TicketCell request={badgedRequest()} onReview={() => {}} />);

    fireEvent.mouseEnter(screen.getByRole('button', { name: REVIEW_BUTTON }));

    // Каждое состояние — со своей расшифровкой: без неё значок в подсказке остаётся такой же
    // загадкой, какой был в строке.
    expect(await screen.findByText('⛔ 1 — цифры не сошлись — нужен разбор')).toBeDefined();
    expect(screen.getByText('⚠️ 1 — похоже на расхождение, но бывает законно')).toBeDefined();
    expect(screen.getByText('⏳ 2 — прочитано, ждёт подтверждения')).toBeDefined();
    // Нулевые состояния молчат: пять строк подряд, три из которых про «ничего нет», подсказку
    // читать не помогают.
    expect(screen.queryByText(/🚫/u)).toBeNull();
    expect(screen.queryByText(/📄/u)).toBeNull();
    expect(screen.getByText('Открыть разбор')).toBeDefined();
  });

  it('клик зовёт разбор той самой заявки, а не соседней', () => {
    mockHttp({});
    const onReview = vi.fn();
    const request = badgedRequest();
    renderWithUser(<TicketCell request={request} onReview={onReview} />);

    fireEvent.click(screen.getByRole('button', { name: REVIEW_BUTTON }));

    // Заявкой целиком, а не идентификатором: карточку открывает список, и поля он берёт из
    // строки — второго запроса за ними нет.
    expect(onReview).toHaveBeenCalledWith(request);
  });

  it('красным крестик становится только от несошедшихся цифр', () => {
    mockHttp({});
    // Очередь на подтверждение и нечитаемый файл — работа не срочная: цвет её не зовёт.
    const { unmount } = renderWithUser(
      <TicketCell
        request={badgedRequest({ ...MIXED, errors: 0, warnings: 0, failures: 1 })}
        onReview={() => {}}
      />,
    );
    expect(
      screen.getByRole('button', { name: REVIEW_BUTTON }).className.includes('ant-btn-dangerous'),
    ).toBe(false);
    unmount();

    renderWithUser(<TicketCell request={badgedRequest()} onReview={() => {}} />);
    expect(
      screen.getByRole('button', { name: REVIEW_BUTTON }).className.includes('ant-btn-dangerous'),
    ).toBe(true);
  });

  it('разобранная заявка хода на разбор не получает', () => {
    mockHttp({});
    const clean: WasteTicketBadgeDto = {
      errors: 0,
      warnings: 0,
      pendingConfirmation: 0,
      failures: 0,
      unreviewedPaper: 0,
      confirmable: 0,
      confirmableFingerprint: '',
    };
    const { container } = renderWithUser(
      <TicketCell request={badgedRequest(clean)} onReview={() => {}} />,
    );

    // Крестик звал бы в панель, где разбирать нечего; галочка отвечает на вопрос колонки сама.
    expect(screen.queryByRole('button', { name: REVIEW_BUTTON })).toBeNull();
    expect(container.textContent).toContain('✓');
  });
});

/**
 * Карточка, открытая крестиком, обязана показать разбор. Случай не выдуманный: числа значка
 * считаются и по талону, заведённому руками, — файла у такого нет вовсе, и по прежним условиям
 * блок «Талоны» в карточке оказывался скрыт. Кнопка, ведущая в карточку без панели, хуже значков,
 * которые она заменила.
 */
describe('карточка с разбором открывается и у заявки без приложенной бумаги', () => {
  it('блок «Талоны» показан, когда значок обещает разбор', async () => {
    mockHttp({
      'GET /waste-requests/wr-1/history': () => json([]),
      'GET /waste-requests/wr-1/tickets': () =>
        json({
          tickets: [],
          pages: [],
          files: [],
          checks: [],
          attempts: [],
          blindChecks: [],
          ticketsVolumeM3: 0,
          preliminary: false,
          acceptanceAllowed: true,
          badge: {
            errors: 0,
            warnings: 0,
            pendingConfirmation: 1,
            failures: 0,
            unreviewedPaper: 0,
          },
        }),
      'GET /waste-requests/ticket-recognition/health': () =>
        json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    });

    renderWithUser(
      <WasteRequestViewModal
        // Заявка закрыта, бумаги за ней не числится, донести талон уже нельзя — и всё же за ней
        // висит неподтверждённый талон, заведённый руками.
        request={wasteRequest({
          status: 'completed',
          tickets: [],
          ticketBadge: { ...MIXED, errors: 0, warnings: 0, pendingConfirmation: 1 },
        })}
        focus="tickets"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText('Талоны')).toBeDefined();
  });
});
