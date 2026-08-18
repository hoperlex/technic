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

/**
 * Таблица сводки.
 *
 * Свойств здесь два. Первое — экранирование: в ячейки едут название объекта, адрес площадки и
 * примечание, то есть тот же набранный человеком текст, что и в остальных письмах, только теперь
 * рядом с разметкой таблицы. Второе — текстовая версия: таблица не рисуется псевдографикой, потому
 * что моноширинного шрифта в text/plain никто не обещает, и проверка сторожит именно это.
 */
describe('таблица в письме', () => {
  const ROW_HREF = 'https://portal.test/vehicle-requests?tab=requests&open=461';

  const mail = renderMail({
    title: 'Сводка на 12 августа',
    blocks: [
      {
        kind: 'table',
        head: ['Рейс', 'Заявка', 'Машина', 'Примечание'],
        rows: [
          [
            { text: 'Р-48', href: 'https://portal.test/vehicle-requests?route=48' },
            { text: 'ТС-461', href: ROW_HREF, sub: 'объект «Северный»' },
            { text: 'КамАЗ 65201', sub: 'Е646СК799' },
            { text: '' },
          ],
        ],
      },
    ],
  });

  it('HTML-версия печатает шапку и значения таблицей', () => {
    expect(mail.html).toContain('<table');
    for (const title of ['Рейс', 'Заявка', 'Машина', 'Примечание']) {
      expect(mail.html).toContain(`>${title}</th>`);
    }
    expect(mail.html).toContain('Р-48');
    expect(mail.html).toContain('ТС-461');
    expect(mail.html).toContain('КамАЗ 65201');
    expect(mail.html).toContain('Е646СК799');
  });

  it('ячейка со ссылкой кликабельна, ячейка без ссылки — просто текст', () => {
    expect(mail.html).toContain(`<a href="${ROW_HREF.replace(/&/gu, '&amp;')}"`);
    // Ссылок ровно столько, сколько ячеек с href: остальные значения остались текстом.
    expect(mail.html.match(/<a href=/gu)).toHaveLength(2);
  });

  it('название объекта из ячейки не уезжает в почтовый клиент разметкой', () => {
    const { html } = renderMail({
      title: 'Сводка',
      blocks: [
        {
          kind: 'table',
          head: ['Заявка'],
          rows: [
            [
              {
                text: '<img src=x onerror="alert(1)">',
                href: 'https://portal.test/vehicle-requests?a=1&b="2"',
                sub: `объект <b>«Северный»</b> & 'Южный'`,
              },
            ],
          ],
        },
      ],
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    // Кавычка в адресе закрыла бы атрибут href и вынесла бы остаток строки в разметку.
    expect(html).toContain('href="https://portal.test/vehicle-requests?a=1&amp;b=&quot;2&quot;"');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&amp; &#39;Южный&#39;');
  });

  it('заголовок колонки тоже экранируется: его задаёт шаблон, но правило одно на всё письмо', () => {
    const { html } = renderMail({
      title: 'Сводка',
      blocks: [{ kind: 'table', head: ['<Рейс>'], rows: [[{ text: 'Р-48' }]] }],
    });
    expect(html).toContain('&lt;Рейс&gt;');
    expect(html).not.toContain('<Рейс>');
  });

  it('текстовая версия печатает строку полями, а не псевдографикой', () => {
    expect(mail.text).toContain('Р-48');
    expect(mail.text).toContain('Заявка: ТС-461, объект «Северный»');
    expect(mail.text).toContain('Машина: КамАЗ 65201, Е646СК799');
    // Адрес целиком: в текстовой версии кликают по самому адресу.
    expect(mail.text).toContain(ROW_HREF);
    // Рамки из палочек держатся на моноширинном шрифте, которого в text/plain никто не обещает.
    expect(mail.text).not.toMatch(/[|+]|[─-╿]/u);
    // Пустая ячейка пропущена: «Примечание:» без значения читателю ничего не сообщает.
    expect(mail.text).not.toContain('Примечание');
  });

  it('строки таблицы не слипаются и не копят пустые строки', () => {
    const { text } = renderMail({
      title: 'Сводка',
      blocks: [
        {
          kind: 'table',
          head: ['Рейс', 'Заявка'],
          rows: [
            [{ text: 'Р-48' }, { text: 'ТС-461' }],
            [{ text: 'Р-49' }, { text: 'ТС-455' }],
          ],
        },
      ],
    });
    expect(text).toContain('Р-48\n  Заявка: ТС-461\n\nР-49');
    expect(text).not.toMatch(/\n{3,}/u);
  });

  it('пустая таблица не роняет рендер: день окна может оказаться без единой записи', () => {
    const empty = renderMail({
      title: 'Сводка',
      blocks: [{ kind: 'table', head: ['Рейс', 'Заявка'], rows: [] }],
    });
    expect(empty.html).toContain('<table');
    expect(empty.text).toBe('Сводка');
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
