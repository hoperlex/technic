import { describe, expect, it, vi } from 'vitest';
import { assertOwnOrigin, escapeHtml, renderMail } from '../src/services/mail-templates';

/**
 * Сборка тела письма.
 *
 * Проверяется прежде всего экранирование: в письмо попадает текст, который набирал человек, —
 * комментарий диспетчера, название объекта, адрес площадки. Ошибка здесь не ломает портал и не
 * видна в его интерфейсе: она уезжает в почтовый клиент получателя, где её никто не поймает.
 */

// Шаблоны писем про доступ тянут конфиг: из него берётся адрес портала для ссылки, — а конфиг
// читает окружение при импорте модуля. Поэтому значения выставляются в `vi.hoisted`, то есть до
// импортов, а сам модуль берётся через `await import`: приём тот же, что у соседних тестов,
// которым нужен конфиг без базы.
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://portal.test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/technic_test',
    JWT_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
    COOKIE_SECRET: 'test-cookie-secret-value',
    CSRF_SECRET: 'test-csrf-secret-value',
    S3_ENDPOINT: 'https://s3.test.local',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test-key',
    S3_SECRET_ACCESS_KEY: 'test-secret',
  });
});

const { config } = await import('../src/config');
const { accountCreatedContent, registrationApprovedContent, registrationRejectedContent } =
  await import('../src/services/mail-auth');

describe('экранирование пользовательского текста', () => {
  it('угловые скобки и кавычки не доходят до почтового клиента разметкой', () => {
    expect(escapeHtml('<b>груз</b>')).toBe('&lt;b&gt;груз&lt;/b&gt;');
    expect(escapeHtml('он сказал "поехали"')).toBe('он сказал &quot;поехали&quot;');
  });

  it('амперсанд экранируется первым: иначе сущности экранировались бы дважды', () => {
    expect(escapeHtml('СМУ & Ко <ООО>')).toBe('СМУ &amp; Ко &lt;ООО&gt;');
  });

  it('комментарий диспетчера не превращается в разметку письма', () => {
    const { html } = renderMail({
      title: 'Задание на 7 августа',
      blocks: [{ kind: 'paragraph', text: '<img src=x onerror="alert(1)">' }],
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('текстовая версия остаётся как есть: экранировать в ней нечего', () => {
    const { text } = renderMail({
      title: 'Задание',
      blocks: [{ kind: 'paragraph', text: 'груз < 10 т' }],
    });
    expect(text).toContain('груз < 10 т');
  });
});

describe('текстовая и HTML-версия', () => {
  const mail = renderMail({
    title: 'Задание на 7 августа',
    blocks: [
      { kind: 'heading', text: 'Рейс Р-12' },
      { kind: 'lines', lines: ['Машина: КамАЗ 65201 · Е646СК799', 'Гаражный номер: 314'] },
      { kind: 'list', items: ['ТС-451 · объект «Северный»'] },
      { kind: 'note', text: 'Ссылка действует сутки' },
    ],
    footer: 'Диспетчер: +7 900 000-00-00',
  });

  it('текстовая версия есть у каждого письма: её читают клиенты без HTML', () => {
    expect(mail.text).toContain('Задание на 7 августа');
    expect(mail.text).toContain('РЕЙС Р-12');
    expect(mail.text).toContain('Машина: КамАЗ 65201 · Е646СК799');
    expect(mail.text).toContain('  · ТС-451 · объект «Северный»');
    expect(mail.text).toContain('Диспетчер: +7 900 000-00-00');
  });

  it('пустые строки на стыке блоков схлопываются, а не копятся', () => {
    expect(mail.text).not.toMatch(/\n{3,}/u);
  });

  it('в HTML нет внешних ресурсов: картинки в почте по умолчанию не грузятся', () => {
    expect(mail.html).not.toMatch(/<img|<script|src=/u);
  });
});

describe('ссылки в письме', () => {
  const ORIGIN = 'https://auto.su10.ru';

  it('своя ссылка проходит', () => {
    expect(() => assertOwnOrigin(`${ORIGIN}/reset-password?token=abc`, ORIGIN)).not.toThrow();
  });

  it('чужой домен отвергается: письмо от имени портала со ссылкой наружу — это фишинг', () => {
    expect(() => assertOwnOrigin('https://auto.su10.ru.evil.example/reset', ORIGIN)).toThrow(
      /за пределы портала/u,
    );
  });

  it('неразобранная ссылка отвергается, а не уходит как есть', () => {
    expect(() => assertOwnOrigin('reset-password?token=abc', ORIGIN)).toThrow(/не разобрана/u);
  });
});

/**
 * Письма о решении администратора по учётной записи.
 *
 * Здесь два свойства, которые нельзя увидеть в портале. Первое — ответ администратора: это
 * свободный текст из поля «Ответ заявителю», и он обязан доехать до человека словами, а не
 * разметкой. Второе — пароль: его в этих письмах нет ни в каком виде, и письмо вместо значения
 * показывает дорогу к «Забыли пароль?».
 */
describe('письма о решении по учётной записи', () => {
  /** Ответ администратора набирают руками, и в нём встречается всё сразу. */
  const ADMIN_MESSAGE = `<b>причина</b> "как есть" & 'ещё'`;

  it('ответ администратора доезжает текстом, а не разметкой', () => {
    const mail = renderMail(registrationRejectedContent(ADMIN_MESSAGE));
    expect(mail.html).toContain('&lt;b&gt;причина&lt;/b&gt;');
    expect(mail.html).toContain('&quot;как есть&quot;');
    expect(mail.html).not.toContain('<b>');
    // В текстовой версии экранировать нечего: её читают клиенты без HTML, и текст администратора
    // должен выглядеть в них ровно так, как он его набрал.
    expect(mail.text).toContain(ADMIN_MESSAGE);
  });

  it('в письме об отказе нет ссылок: доступа не появилось, вести человека некуда', () => {
    const content = registrationRejectedContent(ADMIN_MESSAGE);
    expect(content.blocks.filter((b) => b.kind === 'link')).toHaveLength(0);
    expect(renderMail(content).html).not.toContain('<a ');
  });

  it('одобрение и заведение учётки ведут на свой портал, и без токена', () => {
    for (const content of [
      registrationApprovedContent('dispatcher'),
      accountCreatedContent('department_head'),
    ]) {
      const hrefs = content.blocks.flatMap((b) => (b.kind === 'link' ? [b.href] : []));
      expect(hrefs).toHaveLength(1);
      expect(hrefs[0]!.startsWith(config.publicOrigin)).toBe(true);
      expect(() => assertOwnOrigin(hrefs[0]!, config.publicOrigin)).not.toThrow();
      // Токена в ссылке нет намеренно: она ведёт на страницу входа, а не открывает доступ сама.
      expect(hrefs[0]).not.toContain('token=');
    }
  });

  it('роль названа словами: код роли человеку ничего не говорит', () => {
    expect(renderMail(registrationApprovedContent('dispatcher')).text).toContain('Диспетчер');
    const created = renderMail(accountCreatedContent('department_head')).text;
    expect(created).toContain('Руководитель отдела');
    expect(created).not.toContain('department_head');
  });
});

describe('пароль в письмах о доступе', () => {
  /**
   * Пароль, который однажды кто-нибудь захочет вложить в письмо «для удобства». Передать его этим
   * шаблонам сейчас нечем — и проверка сторожит ровно это: появится у шаблона параметр с паролем
   * или временным паролем, значение окажется в тексте письма, и тест упадёт раньше, чем письмо
   * уйдёт человеку и останется в его ящике навсегда.
   */
  const PASSWORD = 'Vremennyj-Parol-2026';

  const letters: [string, ReturnType<typeof renderMail>][] = [
    ['отказ по заявке', renderMail(registrationRejectedContent('Такой сотрудник не найден.'))],
    ['доступ открыт', renderMail(registrationApprovedContent('dispatcher'))],
    ['учётная запись заведена', renderMail(accountCreatedContent('observer'))],
  ];

  it.each(letters)('%s: значения пароля в письме нет', (_name, mail) => {
    expect(mail.text).not.toContain(PASSWORD);
    expect(mail.html).not.toContain(PASSWORD);
  });

  it('вместо пароля письма показывают дорогу — «Забыли пароль?» на странице входа', () => {
    expect(renderMail(registrationApprovedContent('dispatcher')).text).toContain(
      '«Забыли пароль?»',
    );
    expect(renderMail(accountCreatedContent('observer')).text).toContain('«Забыли пароль?»');
  });
});
