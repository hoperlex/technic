import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  deviceIdentityHintsSchema,
  type AuthUser,
  type DeviceMailQueueDto,
  type DeviceMailQueueItemDto,
  type DeviceMailboxStateDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { selectOption } from './antd';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { BIND_TARGETS_PREFIX, MAILBOX_STUCK_PREFIX } from '../src/features/device-mail-review';
import { DeviceMailReview, NO_HINTS_TEXT } from '../src/pages/service/DeviceMailReview';

/**
 * ОЧЕРЕДЬ «ПИСЬМА УСТРОЙСТВ» — режим внутри вкладки «Техника» (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §10, §12) против замороженных DTO.
 *
 * Проверяется то, ради чего экран написан именно так, и ничего сверх:
 *
 *   1. СОСТАВ ОЧЕРЕДИ ВИДЕН ЦЕЛИКОМ, включая письмо, закрытое счётчиком застревания (`ignored` с
 *      кодом `stuck`). Отбор считает сервер, но экран обязан показать всё, что тот отдал: строка,
 *      потерянная разметкой, ничем не отличается от строки, потерянной отбором;
 *   2. «ПЕРЕЧИТАТЬ» ПОКАЗЫВАЕТСЯ ТОЛЬКО ПРИ `rawState === 'stored'`. У переростка тела не было
 *      вовсе, у старого письма сырьё вычищено по сроку — падающая кнопка без объяснения хуже
 *      отсутствующей;
 *   3. ЧИСЛО ЗАТРОНУТЫХ ПИСЕМ ПОКАЗЫВАЕТСЯ ДО ПОДТВЕРЖДЕНИЯ (Р20 требует этого буквально) и
 *      приходит С СЕРВЕРА: портал его не считает и посчитать не может — пачка ищется по снимкам
 *      всех накопленных писем, а у экрана на руках одна страница;
 *   4. СТРОКА СОСТОЯНИЯ ЯЩИКА ЕСТЬ И ПРИ ПУСТОЙ ОЧЕРЕДИ (§9.1, п. 8): застрявшее письмо может не
 *      иметь своей строки в базе вовсе, и тогда «курсор стоит с такого-то времени, причина» —
 *      единственное место, где беда видна. Проверяются оба исхода поля `cursorStuckAt`;
 *   5. «ИГНОРИРОВАТЬ» И «ПРОСМОТРЕНО» — РАЗНЫЕ ДЕЙСТВИЯ, оба необратимы и оба спрашивают
 *      подтверждение, называющее последствие. Доступность отметки приходит ФЛАГОМ `canReview` — тем
 *      же ответом сервера, которым он стережёт ручку, — а отказ устаревшей страницы доезжает до
 *      человека СЛОВАМИ: без этого письмо со снимком уходило бы из очереди навсегда, оставаясь при
 *      этом в отборе пачки;
 *   6. АДРЕС ПОЛУЧАТЕЛЯ ВИДЕН И ПОДСТАВЛЯЕТСЯ: `envelopeTo` — законный род ключа (плюс-адресация,
 *      Р10), и выбрать его, не видя значения, значило бы набирать адрес по памяти.
 */

/** Разбирает очередь ИТ-служба: своё право плюс чтение справочника, которого оно требует (Р30). */
const REVIEWER: AuthUser = authUser({
  role: 'manager',
  grantPermissions: ['officeEquipment.read', 'officeEquipment.telemetry'],
});

const NO_HINTS = deviceIdentityHintsSchema.parse({});

function item(over: Partial<DeviceMailQueueItemDto> = {}): DeviceMailQueueItemDto {
  return {
    id: 'msg-1',
    status: 'unmatched',
    rawState: 'stored',
    receivedAt: '2026-09-16T06:00:00.000Z',
    deviceTime: '2026-09-16T05:58:00.000Z',
    fromAddress: 'mfp-214@example.invalid',
    envelopeTo: 'mfp+214@example.test',
    subject: 'Device Status Report',
    profileCode: 'ricoh',
    errorCode: null,
    errorText: '',
    identity: { ...NO_HINTS, serial: 'W512P900123', deviceName: 'RICOH-214', ip: '10.10.0.7' },
    observationCount: 5,
    eventCount: 1,
    canReparse: true,
    // Умолчание — письмо, ждущее привязки: у него выход есть, и отметка просмотра ему закрыта.
    canReview: false,
    ...over,
  };
}

const mailbox = (over: Partial<DeviceMailboxStateDto> = {}): DeviceMailboxStateDto => ({
  account: 'mfp@example.invalid',
  lastPollAt: '2026-09-16T07:00:00.000Z',
  cursorStuckAt: null,
  lastError: '',
  stuckAttempts: 0,
  ...over,
});

const queue = (
  items: DeviceMailQueueItemDto[],
  boxes: DeviceMailboxStateDto[] = [mailbox()],
): DeviceMailQueueDto => ({
  mailbox: boxes,
  items: { items, hasMore: false, nextCursor: null },
});

function renderQueue(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /device-mail/queue': () => json(queue([item()])),
    // Подбор карточки в окне привязки: список справочника спрашивается с открытием окна.
    'GET /office-equipment': () => json({ items: [], total: 0, page: 1, pageSize: 20 }),
    ...over,
  });
  renderWithUser(<DeviceMailReview />, { user: REVIEWER });
  return http;
}

describe('очередь «Письма устройств»', () => {
  it('показывает и разобранные, и застрявшие письма — включая закрытые счётчиком', async () => {
    renderQueue({
      'GET /device-mail/queue': () =>
        json(
          queue([
            item(),
            item({
              id: 'msg-2',
              status: 'ignored',
              // Письмо, закрытое счётчиком застревания: сырья у него нет, снимка нет, и убрать его
              // из очереди можно ТОЛЬКО отметкой просмотра.
              errorCode: 'stuck',
              errorText: 'десять заходов подряд без исхода',
              rawState: 'absent',
              identity: NO_HINTS,
              subject: 'Service Call SC552',
              observationCount: 0,
              eventCount: 0,
              canReparse: false,
              // Ни снимка, ни сырья: другого выхода у строки нет, и отметка просмотра — её
              // единственный. Флаг считает сервер тем же предикатом, которым стережёт ручку.
              canReview: true,
            }),
          ]),
        ),
    });

    expect(await screen.findByText('Device Status Report')).toBeDefined();
    expect(screen.getByText('Service Call SC552')).toBeDefined();
    // Подписи статусов берутся из контракта: два экрана модуля читают один словарь.
    expect(screen.getByText('Аппарат не опознан')).toBeDefined();
    expect(screen.getByText('Отброшено')).toBeDefined();
    expect(screen.getByText('десять заходов подряд без исхода')).toBeDefined();
    // Подсказки опознания — тому, кто будет привязывать: серийник, имя, IP.
    expect(screen.getByText('W512P900123')).toBeDefined();
    expect(screen.getByText('RICOH-214')).toBeDefined();
    expect(screen.getByText('10.10.0.7')).toBeDefined();
    // Письмо, не назвавшее себя ничем, говорит об этом словами, а не пустой ячейкой.
    expect(screen.getByText(NO_HINTS_TEXT)).toBeDefined();
    /*
     * ОТМЕТКУ ПРОСМОТРА ПРЕДЛАГАЮТ РОВНО ОДНОЙ СТРОКЕ — той, у которой других выходов нет.
     * Непривязанное письмо со снимком так закрывать нельзя: оно ушло бы из очереди навсегда,
     * оставшись в отборе пачки, — и будущая привязка того же серийника применила бы его молча.
     * Решает это флаг `canReview` с сервера, а не разбор статуса на экране.
     */
    expect(screen.getAllByText('Просмотрено')).toHaveLength(1);
    // «Игнорировать» при этом есть у обеих: ненужное отбрасывают, а не «просматривают».
    expect(screen.getAllByText('Игнорировать')).toHaveLength(2);
  });

  it('«Перечитать» есть у сохранённого сырья и скрыто, когда перечитывать нечем', async () => {
    renderQueue({
      'GET /device-mail/queue': () =>
        json(
          queue([
            item({ id: 'msg-stored', subject: 'Сырьё на месте', rawState: 'stored' }),
            // `purged` — вычищено по сроку хранения; `absent` — тела не было вовсе (переросток).
            item({
              id: 'msg-purged',
              subject: 'Сырьё вычищено',
              rawState: 'purged',
              canReparse: false,
            }),
            item({
              id: 'msg-absent',
              subject: 'Тело не качалось',
              rawState: 'absent',
              canReparse: false,
            }),
          ]),
        ),
    });

    expect(await screen.findByText('Сырьё на месте')).toBeDefined();
    // Ровно одна кнопка на три строки: признак приходит с сервера полем `canReparse`, и портал
    // своей копии правила не заводит.
    expect(screen.getAllByText('Перечитать')).toHaveLength(1);
  });

  it('перед привязкой показывает, сколько писем будет затронуто, и число это — серверное', async () => {
    const http = renderQueue({
      'GET /device-mail/messages/:id/bind-targets': () => json({ messages: 4 }),
    });
    await screen.findByText('Device Status Report');

    fireEvent.click(screen.getByText('Привязать'));

    // Число приехало с сервера тем же отбором, каким привязка и применится (Р20).
    expect(await screen.findByText(`${BIND_TARGETS_PREFIX}4`)).toBeDefined();
    await waitFor(() => expect(http.countOf('GET /device-mail/messages/:id/bind-targets')).toBe(1));
    // Ключ по умолчанию — серийный номер из снимка: он опознающий, и пачка законна именно по нему.
    const call = http.lastCall('GET /device-mail/messages/:id/bind-targets');
    expect(call?.query.get('kind')).toBe('serial');
    expect(call?.query.get('value')).toBe('W512P900123');
  });

  it('оба необратимых действия переспрашивают, а отказ устаревшей страницы виден словами', async () => {
    const http = renderQueue({
      // Строка с поднятым флагом: у неё отметка просмотра — единственный выход.
      'GET /device-mail/queue': () => json(queue([item({ canReview: true })])),
      /*
       * Сервер отказывает, хотя флаг был поднят, — и это не противоречие, а ВТОРОЙ РУБЕЖ: страницу
       * открыли полчаса назад, а письмо за это время перечитали, и выход у него появился. Флаг
       * прячет кнопку, барьер ручки стережёт саму запись, и отказ обязан доехать словами.
       */
      'POST /device-mail/messages/:id/reviewed': () =>
        apiError(422, {
          code: 'unprocessable_entity',
          message:
            'Письмо ждёт привязки к аппарату — свяжите его с карточкой; ненужное закройте действием «Игнорировать»',
        }),
      'POST /device-mail/messages/:id/ignore': () => json({ id: 'msg-1', status: 'ignored' }),
    });
    await screen.findByText('Device Status Report');

    // ── Отметка просмотра: подтверждение, потом отказ сервера словами ──
    fireEvent.click(screen.getByText('Просмотрено'));
    // Подтверждение называет ПОСЛЕДСТВИЕ, а не переспрашивает «вы уверены»: вернуть строку в
    // очередь нечем — списка просмотренных в портале нет.
    expect(await screen.findByText(/уйдёт из очереди навсегда/)).toBeDefined();
    fireEvent.click(screen.getByText('Отметить'));

    await waitFor(() => expect(http.countOf('POST /device-mail/messages/:id/reviewed')).toBe(1));
    // Отказ доехал до человека ДОСЛОВНО: «нельзя» без продолжения он прочитал бы как поломку.
    expect(await screen.findByText(/ненужное закройте действием/)).toBeDefined();

    // ── Отбрасывание: своё подтверждение, своя ручка ──
    fireEvent.click(screen.getByText('Игнорировать'));
    expect(await screen.findByText(/его показания в карточку не попадут/)).toBeDefined();
    fireEvent.click(screen.getByText('Отбросить'));

    await waitFor(() => expect(http.countOf('POST /device-mail/messages/:id/ignore')).toBe(1));
    // Два действия — две РАЗНЫЕ ручки: слитые в одну, они дали бы мусору со снимком остаться в
    // отборе пачки и примениться при будущей привязке того же серийника молча.
    expect(http.countOf('POST /device-mail/messages/:id/reviewed')).toBe(1);
  });

  it('кнопка «Просмотрено» рисуется по флагу сервера, а не по разбору статуса на экране', async () => {
    renderQueue({
      'GET /device-mail/queue': () =>
        json(
          queue([
            item({ id: 'msg-open', subject: 'выход есть', canReview: false }),
            item({ id: 'msg-dead', subject: 'выхода нет', canReview: true }),
          ]),
        ),
    });
    await screen.findByText('выход есть');

    /*
     * Флаг — ОДИН ответ на два вопроса: что показать экрану и что пропустить ручке. Считает его
     * сервер тем же предикатом, которым и отказывает, поэтому спрятанная кнопка и отказ ручки
     * разойтись не могут. Своей копии правила экран не держит намеренно: она расходилась бы молча,
     * и человек нажимал бы кнопку, получая 422 (AGENTS.md, «правило одного места»).
     */
    const rows = screen.getAllByRole('row');
    const openRow = rows.find((row) => row.textContent?.includes('выход есть'));
    const deadRow = rows.find((row) => row.textContent?.includes('выхода нет'));
    expect(openRow?.textContent).not.toContain('Просмотрено');
    expect(deadRow?.textContent).toContain('Просмотрено');
    // Ровно одна на две строки: подсчёт ловит и «показали всем», и «спрятали у всех».
    expect(screen.getAllByText('Просмотрено')).toHaveLength(1);
  });

  it('адрес получателя виден в окне привязки и подставляется значением ключа (Р10)', async () => {
    const http = renderQueue({
      'GET /device-mail/messages/:id/bind-targets': () => json({ messages: 1 }),
    });
    await screen.findByText('Device Status Report');

    fireEvent.click(screen.getByText('Привязать'));
    // Сам адрес показан: выбрать род «Адрес получателя», не видя значения, значило бы набирать его
    // по памяти — а плюс-адресация (`mfp+214@…`) отличается от отправителя одним словом.
    expect(await screen.findByText('mfp+214@example.test')).toBeDefined();

    await selectOption('Чем связываем', 'Адрес получателя');

    await waitFor(() => {
      const call = http.lastCall('GET /device-mail/messages/:id/bind-targets');
      expect(call?.query.get('kind')).toBe('envelopeTo');
      // Значение подставлено из строки очереди, а не оставлено прежним серийником.
      expect(call?.query.get('value')).toBe('mfp+214@example.test');
    });
  });

  it('состояние ящика видно и тогда, когда очередь пуста', async () => {
    renderQueue({
      'GET /device-mail/queue': () =>
        json(
          queue(
            [],
            [
              mailbox({
                cursorStuckAt: '2026-09-16T04:00:00.000Z',
                lastError: 'storage_unavailable: хранилище недоступно',
                stuckAttempts: 3,
              }),
            ],
          ),
        ),
    });

    // 16.09 07:00 по Москве — 04:00 UTC. Пустая очередь при стоящем курсоре означает не «всё
    // разобрано», а «приём умер», и экран обязан различать эти два состояния.
    expect(await screen.findByText(`${MAILBOX_STUCK_PREFIX}16.09.2026 07:00`)).toBeDefined();
    expect(screen.getByText(/storage_unavailable/)).toBeDefined();
    expect(screen.getByText(/попыток: 3/)).toBeDefined();
  });
});
