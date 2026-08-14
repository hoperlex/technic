import { describe, expect, it, vi } from 'vitest';

/**
 * Почтовые каналы воркера (план `docs/office-equipment-mail-and-history-plan.md`, Р83–Р87).
 *
 * Проверяется то, что иначе обнаруживается ночью на первом письме: канал, объявленный наполовину,
 * перепутанная пара «порт + защита», незнакомый метод аутентификации. Все три случая обязаны падать
 * на старте — до того, как первое письмо встанет в очередь и начнёт ждать.
 *
 * И обратное: канал, не объявленный вовсе, — не ошибка. Сервер может знать про основной канал и не
 * знать про ящик службы; письма службы тогда ждут настройки, а остальные идут своим ходом.
 */

vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: async () => ({}), close: () => {} }) },
}));

const { createMailAccounts } = await import('../src/mail-accounts');

const SMTP_ENV = {
  SMTP_HOST: 'smtp.example.invalid',
  SMTP_PORT: '587',
  SMTP_USER: 'portal@example.invalid',
  SMTP_PASSWORD: 'secret',
  MAIL_FROM: 'Портал <portal@example.invalid>',
} as NodeJS.ProcessEnv;

const REPAIR_ENV = {
  MAIL_ACCOUNT_REPAIR_HOST: 'm.example.invalid',
  MAIL_ACCOUNT_REPAIR_PORT: '465',
  MAIL_ACCOUNT_REPAIR_USER: 'repair@example.invalid',
  MAIL_ACCOUNT_REPAIR_PASSWORD: 'secret',
  MAIL_ACCOUNT_REPAIR_FROM: 'Ремонт <repair@example.invalid>',
  MAIL_ACCOUNT_REPAIR_AUTH_METHOD: 'CRAM-MD5',
  MAIL_ACCOUNT_REPAIR_MAX_PER_MINUTE: '5',
} as NodeJS.ProcessEnv;

const create = (env: NodeJS.ProcessEnv, enabled = true) =>
  createMailAccounts({ enabled, transport: 'smtp', defaultMaxPerMinute: 60, env }, () => {});

describe('почтовые каналы', () => {
  it('канал объявляется своими переменными и получает свой потолок', () => {
    const accounts = create({ ...SMTP_ENV, ...REPAIR_ENV });

    expect([...accounts.keys()]).toEqual(['default', 'repair']);
    const repair = accounts.get('repair')!;
    expect(repair.cfg.host).toBe('m.example.invalid');
    expect(repair.cfg.from).toContain('repair@example.invalid');
    expect(repair.cfg.authMethod).toBe('CRAM-MD5');

    // Потолок свой: пять писем канала кончаются, а основной канал этого не замечает.
    for (let i = 0; i < 5; i += 1) expect(repair.rate.take()).toBe(true);
    expect(repair.rate.take()).toBe(false);
    expect(accounts.get('default')!.rate.take()).toBe(true);
  });

  it('незаявленный канал — не ошибка, а «письма подождут»', () => {
    const accounts = create(SMTP_ENV);

    expect([...accounts.keys()]).toEqual(['default']);
    expect(accounts.get('repair')).toBeUndefined();
  });

  it('выключенная почта не поднимает ни одного канала', () => {
    expect(create({ ...SMTP_ENV, ...REPAIR_ENV }, false).size).toBe(0);
  });

  /**
   * Половина настроек — худший случай: канал выглядит заведённым, письма на него уходят, а
   * отправить их нечем. Поэтому отказ старта, а не пропуск канала.
   */
  it('канал, объявленный наполовину, роняет старт с именами переменных', () => {
    expect(() => create({ ...SMTP_ENV, MAIL_ACCOUNT_REPAIR_HOST: 'm.example.invalid' })).toThrow(
      /MAIL_ACCOUNT_REPAIR_USER/,
    );
  });

  it('порт и защита проверяются парой', () => {
    expect(() =>
      create({ ...SMTP_ENV, ...REPAIR_ENV, MAIL_ACCOUNT_REPAIR_SECURE: 'false' }),
    ).toThrow(/465 требует SECURE=true/);

    expect(() =>
      create({
        ...SMTP_ENV,
        ...REPAIR_ENV,
        MAIL_ACCOUNT_REPAIR_PORT: '587',
        MAIL_ACCOUNT_REPAIR_SECURE: 'true',
      }),
    ).toThrow(/587 требует SECURE=false/);
  });

  it('умолчание защиты выводится из порта', () => {
    const accounts = create({
      ...SMTP_ENV,
      ...REPAIR_ENV,
      MAIL_ACCOUNT_REPAIR_SECURE: '',
    });
    expect(accounts.get('repair')!.cfg.secure).toBe(true);
    expect(accounts.get('default')!.cfg.secure).toBe(false);
  });

  it('незнакомый метод аутентификации не доезжает до библиотеки', () => {
    expect(() =>
      create({ ...SMTP_ENV, ...REPAIR_ENV, MAIL_ACCOUNT_REPAIR_AUTH_METHOD: 'OAUTH' }),
    ).toThrow(/неизвестный метод аутентификации/);
  });
});
