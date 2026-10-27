import { describe, expect, it } from 'vitest';
import { routeTimeByRequest, type DriverAssignmentAction } from '@technic/contracts';
import { routeSummary, stopPointTimes, type ShownStop } from '../src/pages/driver/readingStops';

/**
 * «Время по заявкам» of the cabinet is keyed by the request the server names on the task (ADR 0234):
 * the server's split reads the stop snapshot by request id, and the preview has to count the same
 * shares under the same keys. A server older than `DriverAssignmentAction.request` names no
 * request, and the cabinet still groups by the request part of the row's number.
 */

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';

function action(displayNumber: string, request?: { id: string; displayNumber: string }) {
  const row: DriverAssignmentAction = {
    role: 'load',
    roleLabel: 'Грузим',
    displayNumber,
    customerName: 'ООО «Заказчик»',
    cargoLabel: '',
    comment: '',
  };
  return request ? { ...row, request } : row;
}

function stopAt(position: number, actions: DriverAssignmentAction[]): ShownStop {
  return {
    key: `p${position}`,
    position,
    routePointId: null,
    location: `Точка ${position}`,
    plannedTime: '',
    actions,
  };
}

const times = {
  p1: { arrivedAt: '07:40', departedAt: '08:30' },
  p2: { arrivedAt: '', departedAt: '10:05' },
  p3: { arrivedAt: '', departedAt: '11:50' },
};

describe('время по заявкам в кабинете', () => {
  it('группирует по заявке сервера, подписывает её номером — доли те же, что на сервере', () => {
    const b = { id: B, displayNumber: 'ТС-41' };
    const a = { id: A, displayNumber: 'ТС-40' };
    // Two trips of ТС-41 and one of ТС-40 at the shared stop: one share each, as in the snapshot.
    const stops = [
      stopAt(1, [action('ТС-41/1', b), action('ТС-41/2', b), action('ТС-40/1', a)]),
      stopAt(2, [action('ТС-41/1', b)]),
      stopAt(3, [action('ТС-40/1', a), action('ТС-41/2', b)]),
    ];

    const summary = routeSummary(stops, times);
    if (summary.kind !== 'ok') throw new Error(`Доли не посчитаны: ${summary.kind}`);

    // The route meets ТС-41 first; the label is the server's number, not a part of the row's.
    expect(summary.requests.map(({ key, label }) => ({ key, label }))).toEqual([
      { key: B, label: 'ТС-41' },
      { key: A, label: 'ТС-40' },
    ]);
    // The server splits the snapshot by request id with the same contract function.
    const server = routeTimeByRequest(
      stopPointTimes(stops, times),
      new Map([
        [1, [A, B]],
        [2, [B]],
        [3, [A, B]],
      ]),
    );
    if (!server.ok) throw new Error('Сервер не разделил время');
    expect(Object.fromEntries(summary.requests.map((r) => [r.key, r.seconds]))).toEqual(
      server.byRequest,
    );
    expect(summary.shared).toEqual([
      { position: 1, shareSeconds: 25 * 60 },
      { position: 3, shareSeconds: (105 * 60) / 2 },
    ]);
  });

  it('старый сервер заявку не называет — ключ и подпись из номера строки', () => {
    const stops = [
      stopAt(1, [action('ТС-41/1'), action('ТС-77 · 12.08')]),
      stopAt(2, [action('ТС-41/2')]),
      stopAt(3, [action('ТС-77 · 12.08')]),
    ];

    const summary = routeSummary(stops, times);
    if (summary.kind !== 'ok') throw new Error(`Доли не посчитаны: ${summary.kind}`);

    expect(summary.requests).toEqual([
      { key: 'ТС-41', label: 'ТС-41', seconds: (25 + 95) * 60 },
      { key: 'ТС-77', label: 'ТС-77', seconds: (25 + 105) * 60 },
    ]);
  });
});
