import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ModuleMailRecipientDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { selectOption } from './antd';
import { ServiceMailRecipientsBlock } from '../src/pages/admin/ServiceMailRecipientsBlock';

/**
 * Служебные адреса писем модулей (план `docs/office-equipment-mail-and-history-plan.md`, Р64, Р71).
 *
 * Проверяется то, чего не видно ни в контрактах, ни на сервере: что администратор может завести
 * адрес и что настройка обратного адреса доезжает до запроса в том виде, в каком её понимает
 * сервер. Запасной адрес у режима «автору» — не подробность формы: без него ответ уйдёт в никуда
 * ровно тогда, когда у заявителя нет почты.
 *
 * Отдельно — право: список открыт по `mailings.read`, а правка по `mailings.manage`. Кнопка,
 * доступная тому, кому сервер откажет, — это 403 на нажатии, а не подсказка.
 */

const LIST = 'GET /admin/mail/recipients';
const CREATE = 'POST /admin/mail/recipients';

const ROW: ModuleMailRecipientDto = {
  id: 'r-1',
  event: 'service_request_waiting_it',
  toEmail: 'repair@example.test',
  isEnabled: true,
  replyToMode: 'author',
  replyToEmail: 'operator@example.test',
  comment: 'Отдел ИТ',
  version: 0,
  createdAt: '2026-08-14T09:00:00.000Z',
  updatedAt: '2026-08-14T09:00:00.000Z',
  updatedByName: 'Админов Антон',
};

function renderBlock(user: AuthUser = authUser({ role: 'admin' }), rows = [ROW]): HttpMock {
  const http = mockHttp({
    [LIST]: () => json(rows),
    [CREATE]: () => json({ ...ROW, id: 'r-2' }, 201),
  });
  renderWithUser(<ServiceMailRecipientsBlock />, { user });
  return http;
}

describe('служебные адреса писем', () => {
  it('показывает событие, ящик и то, куда уйдёт ответ', async () => {
    renderBlock();

    expect(await screen.findByText('repair@example.test')).toBeTruthy();
    expect(screen.getByText('Заявка на обслуживание ждёт визы ИТ')).toBeTruthy();
    // У режима «автору» адрес в строке — запасной, и подписан он именно так: иначе его прочитают
    // как «ответ всегда уходит сюда».
    expect(screen.getByText('Автору заявки')).toBeTruthy();
    expect(screen.getByText('запасной: operator@example.test')).toBeTruthy();
  });

  it('пустой список объясняет, что писем не будет', async () => {
    renderBlock(authUser({ role: 'admin' }), []);

    expect(await screen.findByText('Адресов нет — письма по событиям не уходят')).toBeTruthy();
  });

  it('новый адрес уходит вместе с режимом ответа и запасным адресом', async () => {
    const http = renderBlock();
    await screen.findByText('repair@example.test');

    fireEvent.click(screen.getByRole('button', { name: /Добавить адрес/ }));
    fireEvent.change(await screen.findByLabelText('Адрес службы'), {
      target: { value: 'it@example.test' },
    });
    await selectOption('Куда уйдёт ответ', 'Автору заявки');
    // Подпись поля меняется вслед за режимом (`Form.useWatch` — асинхронно), поэтому именно
    // `findBy`: у «автора» тот же адрес значит уже не «куда отвечать», а «куда, если у него нет
    // почты».
    fireEvent.change(await screen.findByLabelText('Запасной адрес ответа'), {
      target: { value: 'operator@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf(CREATE)).toBe(1));
    expect(http.lastCall(CREATE)?.body).toMatchObject({
      event: 'service_request_waiting_it',
      toEmail: 'it@example.test',
      replyToMode: 'author',
      replyToEmail: 'operator@example.test',
      isEnabled: true,
    });
  });

  /**
   * У общего адреса портала своего адреса не бывает: там отвечает `MAIL_REPLY_TO`. Поле обязано
   * исчезнуть, а не остаться пустым и необязательным, — иначе заполнить его можно, и сервер
   * ответит отказом на кнопке (это же держит CHECK).
   */
  it('у режима «общий адрес портала» поля адреса нет', async () => {
    renderBlock();
    await screen.findByText('repair@example.test');

    fireEvent.click(screen.getByRole('button', { name: /Добавить адрес/ }));
    await screen.findByLabelText('Адрес службы');
    expect(screen.getByLabelText('Адрес для ответов')).toBeTruthy();

    await selectOption('Куда уйдёт ответ', 'На общий адрес портала');
    await waitFor(() => expect(screen.queryByLabelText('Адрес для ответов')).toBeNull());
    expect(screen.queryByLabelText('Запасной адрес ответа')).toBeNull();
  });

  /**
   * Права `mailings.read` и `mailings.manage` сегодня выданы одним и тем же ролям, но разъехаться
   * им ничто не мешает — так и написано в каталоге прав. Проверяется ветка `canManage`: у роли без
   * управления рассылками кнопок нет вовсе, а не «есть, но отвечают 403».
   */
  it('без права управления рассылками правка недоступна', async () => {
    renderBlock(authUser({ role: 'observer' }));

    expect(await screen.findByText('repair@example.test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Добавить адрес/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Изменить' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull();
  });
});
