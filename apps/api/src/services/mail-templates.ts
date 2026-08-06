/**
 * Сборка тела письма: один безопасный layout на все письма портала.
 *
 * Письмо составляется блоками, а не строкой HTML, по двум причинам. Первая — экранирование: в
 * письмо попадают комментарий диспетчера, название объекта и адрес площадки, то есть текст,
 * который набирал человек; собирай мы HTML конкатенацией, первая же угловая скобка в комментарии
 * ломала бы вёрстку, а `<img onerror=…>` из названия объекта — уезжал бы в почтовый клиент
 * получателя. Вторая — текстовая версия: она обязана быть у каждого письма (часть водителей читает
 * почту в клиентах без HTML), и собирать её отдельно значило бы поддерживать два описания одного
 * письма, которые разъедутся на первой же правке.
 *
 * Произвольного HTML в письмах нет и не предполагается: администратор задаёт тему и подпись
 * текстом, а не разметкой.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Амперсанд первым: иначе он экранировал бы уже вставленные сущности во второй раз. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (c) => HTML_ESCAPES[c]!);
}

export type MailBlock =
  /** Заголовок раздела: рейс, блок дайджеста. */
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  /** Строки «поле: значение» — тем же порядком, каким их читают в портале. */
  | { kind: 'lines'; lines: string[] }
  | { kind: 'list'; items: string[] }
  /** Ссылка действия: подтверждение адреса, сброс пароля, отфильтрованный экран портала. */
  | { kind: 'link'; href: string; label: string }
  /** Приписка мелким шрифтом: срок действия ссылки, «письмо отправлено вручную для проверки». */
  | { kind: 'note'; text: string };

export interface MailContent {
  /** Заголовок первой строкой письма; в тему не подставляется — тему задаёт вызывающий. */
  title: string;
  blocks: MailBlock[];
  /** Подпись: кто отправил и куда звонить. */
  footer?: string;
}

export interface RenderedMail {
  text: string;
  html: string;
}

/**
 * Ссылки в письме — только на свой портал. Проверка стоит здесь, а не у вызывающего: письмо с
 * чужой ссылкой, пришедшее от имени портала, — это фишинг с нашей подписью, и такую ошибку нельзя
 * оставлять на внимательность того, кто добавит следующий шаблон.
 */
export function assertOwnOrigin(href: string, publicOrigin: string): void {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new Error(`Ссылка в письме не разобрана: ${href}`);
  }
  if (url.origin !== new URL(publicOrigin).origin) {
    throw new Error(`Ссылка в письме ведёт за пределы портала: ${href}`);
  }
}

function blockToText(block: MailBlock): string[] {
  switch (block.kind) {
    case 'heading':
      return ['', block.text.toUpperCase()];
    case 'paragraph':
      return ['', block.text];
    case 'lines':
      return block.lines;
    case 'list':
      return block.items.map((item) => `  · ${item}`);
    case 'link':
      // Адрес целиком, а не подписанная ссылка: в текстовой версии кликают по самому адресу.
      return ['', `${block.label}: ${block.href}`];
    case 'note':
      return ['', block.text];
  }
}

function blockToHtml(block: MailBlock): string {
  switch (block.kind) {
    case 'heading':
      return `<h2 style="margin:24px 0 8px;font-size:16px;line-height:1.4">${escapeHtml(block.text)}</h2>`;
    case 'paragraph':
      return `<p style="margin:12px 0;line-height:1.5">${escapeHtml(block.text)}</p>`;
    case 'lines':
      return `<div style="margin:8px 0;line-height:1.6">${block.lines
        .map((line) => escapeHtml(line))
        .join('<br>')}</div>`;
    case 'list':
      return `<ul style="margin:8px 0;padding-left:20px;line-height:1.6">${block.items
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join('')}</ul>`;
    case 'link':
      return `<p style="margin:20px 0"><a href="${escapeHtml(block.href)}" style="color:#1677ff">${escapeHtml(block.label)}</a></p>`;
    case 'note':
      return `<p style="margin:12px 0;color:#8c8c8c;font-size:13px;line-height:1.5">${escapeHtml(block.text)}</p>`;
  }
}

/**
 * Одна колонка, никаких таблиц вёрстки и внешних ресурсов: письмо читают с телефона, а картинки в
 * почтовых клиентах по умолчанию не загружаются — значит и держаться на них ничему нельзя.
 */
export function renderMail(content: MailContent): RenderedMail {
  const textLines = [content.title, ...content.blocks.flatMap(blockToText)];
  if (content.footer) textLines.push('', content.footer);
  const text = textLines
    .join('\n')
    // Пустые строки схлопываются: блоки добавляют свой отступ, и на стыке их набегает два-три.
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  const html = [
    '<div style="margin:0;padding:16px;background:#f5f5f5">',
    '<div style="max-width:640px;margin:0 auto;padding:24px;background:#fff;border-radius:8px;',
    'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#141414">',
    `<h1 style="margin:0 0 16px;font-size:18px;line-height:1.4">${escapeHtml(content.title)}</h1>`,
    ...content.blocks.map(blockToHtml),
    content.footer
      ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #f0f0f0;color:#8c8c8c;font-size:13px">${escapeHtml(content.footer)}</p>`
      : '',
    '</div></div>',
  ].join('');

  return { text, html };
}
