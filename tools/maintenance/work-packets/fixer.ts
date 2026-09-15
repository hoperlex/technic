/**
 * Задание исполнителю.
 *
 * Исполнитель чинит РОВНО то, что утвердил отбор, и ничего больше. Найденное попутно он не чинит
 * и не расширяет область: новая проблема записывается отдельной находкой и попадает в следующий
 * круг. Это и есть граница, без которой цикл превращается в бесконечное «починим то, что создала
 * прошлая починка».
 */
import type { TrackedFinding } from '../core/finding.ts';
import type { ConvergenceBudget, PolicySet } from '../core/types.ts';
import type { WorkPacket } from './types.ts';
/*
 * Согласование числительного берётся из отчёта, а не пишется здесь второй раз: задание читают и
 * человек, и агент, и «исправить 1 утверждённых находок» выглядит как сбой генератора, подрывая
 * доверие ко всему тексту. Две реализации одного правила разошлись бы на первом же слове.
 */
import { pluralize } from '../reporters/markdown.ts';

const SCHEMA = `{
  "applied": [
    { "id": "F1", "files": ["путь/от/корня.ts"], "note": "что сделано, одна строка" }
  ],
  "skipped": [
    { "id": "F2", "why": "почему правка не сделана" }
  ],
  "newFindings": [
    {
      "id": "N1",
      "category": "...",
      "title": "...",
      "severity": "high | medium | low",
      "confidence": 0.0,
      "files": ["..."],
      "evidence": "...",
      "behaviorRisk": "low | medium | high",
      "suggestedAction": "..."
    }
  ]
}`;

export interface FixerOptions {
  readonly findings: readonly TrackedFinding[];
  readonly policies: PolicySet;
  readonly budget: ConvergenceBudget;
  readonly outputFile: string;
  /** Уровни проверки, которыми система подтвердит работу. Исполнителю полезно знать заранее. */
  readonly verification: readonly string[];
}

export function fixerPacket(options: FixerOptions): WorkPacket {
  const { findings, budget } = options;
  const files = [...new Set(findings.flatMap((finding) => finding.files))].sort();

  const tasks = findings
    .map((finding) => {
      const head = `### ${finding.id} — ${finding.title}`;
      const meta = `Строгость ${finding.severity}, уверенность ${finding.confidence}, риск для поведения ${finding.behaviorRisk}.`;
      const where = `Файлы: ${finding.files.join(', ')}`;
      const policy = finding.policy === undefined ? '' : `\nПравило: ${finding.policy}`;
      return `${head}\n${meta}\n${where}${policy}\nВидно: ${finding.evidence.trim()}\nЧто сделать: ${finding.suggestedAction.trim()}`;
    })
    .join('\n\n');

  return {
    role: 'fixer',
    goal: `Исправить ${pluralize(findings.length, 'утверждённую находку', 'утверждённые находки', 'утверждённых находок')}, не изменив наблюдаемого поведения.`,
    scope: files,
    inputs: [
      { title: 'Утверждённые находки', body: tasks },
      {
        title: 'Как будет проверена работа',
        body: [
          `После правки система запустит: ${options.verification.join(', ')}.`,
          'Если проверка не пройдёт, вся партия будет откачена целиком — не частично.',
          'Поэтому лучше сделать меньше и пройти проверку, чем больше и не пройти.',
        ].join('\n'),
      },
    ],
    constraints: [
      `Файлов в правке — не больше ${budget.maxFilesChanged}, изменённых строк — не больше ${budget.maxChangedLines}.`,
      'Правьте только перечисленные файлы. Файл, которого нет в списке, трогать нельзя, даже если правка кажется очевидной.',
      'Каждая правка соответствует одной находке. Если находка оказалась неверной — не чините её и запишите в `skipped` с причиной.',
      'Найденное попутно записывайте в `newFindings`. Это не отказ от работы, а единственный правильный способ её передать.',
      'Сохраняйте комментарии, объясняющие причину, инварианты и ссылки на решения. Снимать можно только пересказ очевидного и то, что противоречит сегодняшнему коду.',
    ],
    forbidden: [
      'Менять наблюдаемое поведение: продукт, UX, семантику API, бизнес-правила, схему данных.',
      'Править тесты, чтобы проверка прошла. Тест — доказательство поведения; подгонять доказательство под правку запрещено.',
      'Править конфигурацию линта, бюджеты качества и скрипты проверок.',
      'Расширять область: браться за находки, которых нет в списке.',
      'Переименовывать публичные сущности и менять сигнатуры, если это не названо в самой находке.',
    ],
    expectedOutput:
      'Изменения в рабочем дереве плюс один JSON-объект с отчётом о сделанном. Объект — без текста вокруг.',
    outputSchema: SCHEMA,
    outputFile: options.outputFile,
  };
}
