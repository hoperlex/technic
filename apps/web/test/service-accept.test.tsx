import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { serviceOperator, serviceRequest, serviceRequestFile } from './factories/service';
import { ServiceAcceptModal } from '../src/features/service-accept/ui/ServiceAcceptModal';

/**
 * Планка приёмки и загрузка бумаги одним окном (Р112, Р120).
 *
 * Принять работу без закрывающего документа нельзя: сервер отказывает тем же условием, и кнопка,
 * ведущая в 422, была бы обещанием, которого он не даёт. Но неактивная кнопка без выхода — тупик,
 * поэтому бумагу подшивают здесь же.
 *
 * Главное здесь — **чей DTO читает окно**. Заявка приходит пропом из состояния, поднятого при
 * открытии, и `invalidateQueries` его не трогает: гаси окно кэш сколько угодно, проп останется
 * прежним. Ручка `POST /:id/files` отвечает свежей заявкой, и окно обязано взять её из ответа —
 * иначе, подшив акт, человек смотрел бы на ту же заблокированную кнопку и закрывал окно, чтобы
 * открыть заново. Проверяется это не признаком кнопки, а тем, что приёмка ушла **следующим
 * действием того же окна** и с версией из ответа загрузки.
 */

/** «Ожидает приёмки»: работы предъявлены, закрывающих документов нет ни одного. */
const PRESENTED = serviceRequest({
  status: 'done',
  estimateRevision: 1,
  estimatedTotalAmount: 7100,
  completion: {
    completedAt: '2026-08-06T09:00:00.000Z',
    totalAmount: 7100,
    adjustmentAmount: null,
    adjustmentReason: '',
  },
});

/**
 * Та же заявка, какой её отдаёт `POST /:id/files`: акт подшит, **версия выросла**. Версия здесь не
 * украшение — по ней и видно, из какого DTO окно взяло данные для приёмки.
 */
const WITH_ACT = serviceRequest({
  ...PRESENTED,
  files: [serviceRequestFile('act')],
  version: PRESENTED.version + 1,
});

const UPLOAD_ROUTES: RouteMap = {
  'POST /files/upload-session': () =>
    json({
      fileId: 'file-act',
      uploadUrl: 'https://storage.test/put/file-act',
      objectKey: 'service/file-act.pdf',
      expiresIn: 900,
    }),
  'POST /files/:id/complete': () =>
    json({
      id: 'file-act',
      filename: 'act.pdf',
      contentType: 'application/pdf',
      size: 1024,
      status: 'ready',
      createdAt: '2026-08-06T10:00:00.000Z',
    }),
};

function renderAccept(
  request = PRESENTED,
  routes: RouteMap = {},
): { http: HttpMock; onClose: ReturnType<typeof vi.fn> } {
  const http = mockHttp({ ...UPLOAD_ROUTES, ...routes });
  const onClose = vi.fn();
  renderWithUser(<ServiceAcceptModal request={request} mode="accept" onClose={onClose} />, {
    user: serviceOperator(),
  });
  return { http, onClose };
}

/** Кнопка приёмки: её состояние и есть портальная половина планки (Р112). */
const acceptButton = () => screen.getByRole('button', { name: 'Принять' }) as HTMLButtonElement;

/** Подшить бумагу так же, как это делает человек: файл кладётся в скрытый ввод `Upload`. */
function attachDocument(name = 'Акт выполненных работ.pdf'): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: 'application/pdf',
  });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('приёмка требует закрывающий документ (Р112)', () => {
  it('без единой бумаги приёмку не запирают, но бумагу называют (Н8)', async () => {
    /*
     * Планка закрывающего документа уехала с приёмки на «Решена» (Н8): сервер её здесь больше не
     * спрашивает. Запертая кнопка теперь запирала бы то, что сервер пропускает, — и оставила бы
     * без выхода заявку-наследие, доехавшую до «Решена» без бумаги: автозакрытие такую не берёт, и
     * ручная приёмка — единственный способ её закрыть.
     */
    renderAccept();

    await screen.findByText('Нужен один из документов: акт, счёт или гарантийный талон');
    expect(acceptButton().disabled).toBe(false);
  });

  it('с любым закрывающим документом кнопка активна и предупреждения нет', async () => {
    renderAccept(serviceRequest({ ...PRESENTED, files: [serviceRequestFile('warranty_card')] }));

    await screen.findByText(/Предъявлено/);
    expect(acceptButton().disabled).toBe(false);
    // Планка не требует комплекта: талона довольно, и напоминать про акт со счётом не о чем.
    expect(
      screen.queryByText('Нужен один из документов: акт, счёт или гарантийный талон'),
    ).toBeNull();
  });

  it('возврата на доработку планка не касается: там принимать нечего (Р113)', async () => {
    mockHttp(UPLOAD_ROUTES);
    renderWithUser(<ServiceAcceptModal request={PRESENTED} mode="rework" onClose={() => {}} />, {
      user: serviceOperator(),
    });

    await screen.findByText('Факт закрытия будет стёрт');
    const button = screen.getByRole('button', {
      name: 'Вернуть на доработку',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    // Загрузчика в этом режиме нет вовсе: вопрос «чем закрыта работа» здесь не решают.
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('окно приёмки живёт своим DTO (Р120)', () => {
  it('документ подшивают в том же окне, и заявку принимают, не закрывая его', async () => {
    const accepted = vi.fn();
    const { http, onClose } = renderAccept(PRESENTED, {
      'POST /service-requests/:id/files': () => json(WITH_ACT),
      'PATCH /service-requests/:id/accept': ({ body }) => {
        accepted(body);
        return json(serviceRequest({ ...WITH_ACT, status: 'accepted' }));
      },
    });

    // Кнопка активна и до бумаги (Н8) — окно проверяет не запрет, а то, что подшивка идёт здесь же.
    expect(acceptButton().disabled).toBe(false);

    attachDocument();
    await waitFor(() => expect(http.countOf('POST /service-requests/:id/files')).toBe(1));
    // Вид документа выбран за человека первым из закрывающих: остальное подшивают на вкладке.
    expect(http.lastCall('POST /service-requests/:id/files')?.body).toMatchObject({
      fileIds: ['file-act'],
      kind: 'act',
    });

    // Предупреждение уходит **в том же окне**: ни закрывать, ни открывать заново не пришлось.
    await waitFor(() =>
      expect(
        screen.queryByText('Нужен один из документов: акт, счёт или гарантийный талон'),
      ).toBeNull(),
    );
    expect(acceptButton().disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(acceptButton());
    await waitFor(() => expect(accepted).toHaveBeenCalled());
    /*
     * Версия из ответа загрузки, а не из пропа: возьми окно проп — сервер ответил бы 409 на
     * заявку, которую сам же и подвинул подшивкой файла. Это и есть проверка «окно живёт своим
     * DTO», в отличие от признака кнопки, который мог бы посчитаться и по старым данным.
     */
    expect(accepted.mock.calls[0]![0]).toMatchObject({ version: WITH_ACT.version });
    expect(WITH_ACT.version).not.toBe(PRESENTED.version);

    // Закрывается окно только после самой приёмки — одним закрытием, а не двумя.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
