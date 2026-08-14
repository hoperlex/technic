import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Обратный адрес письма (план `docs/office-equipment-mail-and-history-plan.md`, Р68).
 *
 * До появления колонки `reply_to` адрес был один на весь портал (`MAIL_REPLY_TO`), и ответ службы
 * на письмо по заявке уходил в ящик, где на него никто не отвечает. Теперь адрес принадлежит
 * письму — но только если транспорт его действительно берёт: место, где эта связь рвётся молча,
 * ровно одно, и здесь оно и проверяется.
 *
 * Мокается `nodemailer`, а не SMTP-сервер: вопрос теста не «дошло ли письмо», а «какие поля ушли в
 * `sendMail`».
 */

const sendMail = vi.fn(async () => ({ messageId: 'test-message-id' }));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail, close: () => {} }),
  },
}));

const { createMailTransport } = await import('../src/mail-transport');

const CFG = {
  transport: 'smtp' as const,
  host: 'smtp.example.invalid',
  port: 587,
  secure: false,
  user: 'user',
  password: 'password',
  from: 'Портал <auto@example.invalid>',
  replyTo: 'portal@example.invalid',
};

const MAIL = {
  to: 'service@example.invalid',
  subject: 'Заявка ждёт визы',
  text: 'тело',
  html: '<p>тело</p>',
};

describe('обратный адрес письма', () => {
  beforeEach(() => sendMail.mockClear());

  it('свой адрес письма побеждает общий', async () => {
    const transport = createMailTransport(CFG, () => {});
    await transport.send({ ...MAIL, replyTo: 'author@example.invalid' });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ replyTo: 'author@example.invalid' });
  });

  /**
   * Письма, составленные до появления колонки, лежат в очереди с пустым `reply_to`. Они обязаны
   * уходить ровно так же, как уходили: иначе выкат превратил бы старую очередь в письма без
   * обратного адреса.
   */
  it('без своего адреса берётся общий MAIL_REPLY_TO', async () => {
    const transport = createMailTransport(CFG, () => {});
    await transport.send({ ...MAIL, replyTo: '' });

    expect(sendMail.mock.calls[0]![0]).toMatchObject({ replyTo: 'portal@example.invalid' });
  });

  it('без обоих адресов поля Reply-To в письме нет вовсе', async () => {
    const transport = createMailTransport({ ...CFG, replyTo: '' }, () => {});
    await transport.send(MAIL);

    expect(sendMail.mock.calls[0]![0]).not.toHaveProperty('replyTo');
  });
});
