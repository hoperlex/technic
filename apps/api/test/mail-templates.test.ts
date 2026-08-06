import { describe, expect, it } from 'vitest';
import { assertOwnOrigin, escapeHtml, renderMail } from '../src/services/mail-templates';

/**
 * Сборка тела письма.
 *
 * Проверяется прежде всего экранирование: в письмо попадает текст, который набирал человек, —
 * комментарий диспетчера, название объекта, адрес площадки. Ошибка здесь не ломает портал и не
 * видна в его интерфейсе: она уезжает в почтовый клиент получателя, где её никто не поймает.
 */

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
