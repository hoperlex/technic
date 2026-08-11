#!/usr/bin/env node
/**
 * Отказ формы называет поле, а не показывает тост (ADR 0094).
 *
 * Проверяется одно: `message.warning` не отвечает за незаполненное поле. Такой тост уходит в угол
 * экрана, ничего не помечает и никуда не прокручивает — ровно то, ради чего заводился
 * `useFormBlockers`. Возвращается он незаметно: строчка `message.warning('Укажите …'); return;`
 * пишется быстрее, чем причина в `raise`, и код-ревью её пропускает.
 *
 * Правило намеренно грубое: **любой** `message.warning` — ошибка, кроме перечисленных ниже. Тонкая
 * проверка «внутри ли вызов функции отправки» разбирается о хуки, колбэки и обёртки, а грубая
 * заставляет решать при каждом новом вызове: это про поле (тогда `raise`) или про действие (тогда
 * строка в списке с причиной). `message.error` и `message.success` не трогаются — они отвечают на
 * ответ сервера, а не на пустое поле.
 *
 * Запуск: pnpm --filter @technic/web check:form-blockers
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { walkTs } from './lib/source-scan.mjs';

const SRC = path.resolve(process.cwd(), 'src');

/**
 * Тосты, которые отвечают за действие, а не за поле. Список точный и с причиной: новый вызов здесь
 * — повод решить, чем он на самом деле является, а не привычка.
 */
const ALLOWED = {
  'pages/WasteRequestsPage.tsx':
    'стражи загрузки: число файлов и размер — про действие, не про поле',
  'pages/waste/WasteDoneModal.tsx': 'стражи загрузки талона: число и размер файла',
  'pages/admin/ChangeEmailModal.tsx':
    'предупреждение по итогу успешной смены адреса, а не отказ формы',
  // Оба окна держат строки таблицы состоянием осознанно (итог считается на лету), и перевод их на
  // форму — отдельное решение: см. ADR 0094, «Последствия».
  'features/service-complete/ui/ServiceCompleteModal.tsx':
    'закрытие работ: таблица строк ещё не переведена на форму',
  'features/estimate-editor/ui/EstimateEditorModal.tsx':
    'редактор сметы: таблица строк ещё не переведена на форму',
};

/** `message.warning(...)` — с любым получателем: `message`, `messageApi`, `app.message`. */
function isMessageWarning(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== 'warning') return false;
  const target = callee.expression;
  const name = ts.isIdentifier(target)
    ? target.text
    : ts.isPropertyAccessExpression(target)
      ? target.name.text
      : '';
  return /^message/i.test(name);
}

const offenders = [];
for (const file of walkTs(SRC)) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const code = readFileSync(file, 'utf8');
  if (!code.includes('.warning(')) continue;
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (isMessageWarning(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      if (!ALLOWED[rel]) offenders.push(`${rel}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (offenders.length > 0) {
  console.error('Тост вместо пометки поля (ADR 0094):');
  for (const place of offenders) console.error(`  — ${place}`);
  console.error(
    '\nЕсли это отказ по полю — поднимите его через useFormBlockers().raise({ поле: причина }).\n' +
      'Если это про действие, а не про поле — впишите файл в ALLOWED с причиной ' +
      '(scripts/check-form-blockers.mjs).',
  );
  process.exit(1);
}

console.log(
  `Отказ формы: тостов вместо пометки поля нет (исключений — ${Object.keys(ALLOWED).length}).`,
);
