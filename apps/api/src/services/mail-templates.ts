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

/** Ячейка таблицы: текст и, если он ведёт на запись портала, ссылка; `sub` — вторая строка мелким. */
export interface MailTableCell {
  text: string;
  href?: string;
  sub?: string;
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
  /** Сводка данными: строка на запись портала, первая колонка — то, о чём строка. */
  | { kind: 'table'; head: string[]; rows: MailTableCell[][] }
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
 * Адрес, показанный чужому ящику: первая буква имени и домен целиком (`i***@su10.ru`).
 *
 * Нужно это ровно одному письму — тому, что уходит на **прежний** адрес после смены (ADR 0092). С
 * этого момента прежний ящик к учётке отношения не имеет, и полный новый адрес в нём — лишнее
 * раскрытие: если смену затеял не владелец, письмо само подсказало бы, куда увели вход. Хвоста
 * домена хватает, чтобы владелец узнал свой новый рабочий ящик и понял, что тревожиться не о чем.
 *
 * Живёт здесь, а не рядом с текстом письма: этот модуль ни от чего не зависит, и правило можно
 * проверить тестом, не поднимая конфигурацию портала.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
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
    case 'table':
      return tableToText(block.head, block.rows);
    case 'note':
      return ['', block.text];
  }
}

/**
 * Таблица в text/plain — блоками «заголовок: значение», а не псевдографикой.
 *
 * Рамки из палочек держатся на моноширинном шрифте, которого в текстовой части письма никто не
 * обещает: колонки разъезжаются уже на втором клиенте, а с телефона такую таблицу не прочесть
 * вовсе. Поэтому строка таблицы печатается так же, как задание водителю, — по одному полю в строке.
 */
function tableToText(head: string[], rows: MailTableCell[][]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const rowLines: string[] = [];
    row.forEach((cell, index) => {
      // Первая колонка — то, о чём строка (номер рейса, номер листа). Она печатается без заголовка
      // и без отступа: это подпись всего блока, а «Рейс: Р-48» отодвинуло бы главное вправо и
      // сравняло бы его с полями строки. Остальные колонки без заголовка неопознаваемы.
      const label = index === 0 ? '' : `${head[index] ? `${head[index]}: ` : ''}`;
      const indent = index === 0 ? '' : '  ';
      // Пустая ячейка пропускается: «Примечание:» без значения читателю ничего не сообщает.
      // Уточнение (`sub`) остаётся в строке значения — отдельной строкой оно теряет привязку.
      const value = [cell.text, cell.sub].filter((part) => part?.trim()).join(', ');
      if (value) rowLines.push(`${indent}${label}${value}`);
      // Адрес целиком отдельной строкой — как у блока link: кликают по самому адресу.
      if (cell.href) rowLines.push(`  ${cell.href}`);
    });
    // Пустая строка отделяет строки таблицы друг от друга: иначе поля соседних записей сливаются.
    if (rowLines.length > 0) lines.push('', ...rowLines);
  }
  return lines;
}

/** Ссылка внутри ячейки — тем же цветом, что и блок link: в письме это одна и та же ссылка. */
function cellToHtml(cell: MailTableCell): string {
  const text = cell.href
    ? `<a href="${escapeHtml(cell.href)}" style="color:#1677ff">${escapeHtml(cell.text)}</a>`
    : escapeHtml(cell.text);
  if (!cell.sub) return text;
  return `${text}<br><span style="color:#8c8c8c;font-size:12px">${escapeHtml(cell.sub)}</span>`;
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
    // Стили только inline: `<style>` и внешние таблицы стилей часть почтовых клиентов вырезает.
    case 'table': {
      const head = block.head
        .map(
          (title) =>
            `<th style="padding:6px 8px;background:#fafafa;border-bottom:1px solid #f0f0f0;text-align:left;font-weight:600">${escapeHtml(title)}</th>`,
        )
        .join('');
      const rows = block.rows
        .map(
          (row) =>
            `<tr>${row
              .map(
                (cell) =>
                  `<td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top;word-break:break-word">${cellToHtml(cell)}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('');
      return `<table style="width:100%;margin:12px 0;border-collapse:collapse;font-size:13px"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    }
    case 'note':
      return `<p style="margin:12px 0;color:#8c8c8c;font-size:13px;line-height:1.5">${escapeHtml(block.text)}</p>`;
  }
}

/**
 * Одна колонка, никаких внешних ресурсов: письмо читают с телефона, а картинки в почтовых
 * клиентах по умолчанию не загружаются — значит и держаться на них ничему нельзя. `<table>`
 * появляется только внутри блока table, и только с данными: вёрстку таблицами не делаем.
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
