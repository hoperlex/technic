/**
 * Задание ревьюеру.
 *
 * Ревьюер ищет и описывает. Он не правит код и не решает, что чинить: это разные ответственности,
 * и смешивать их нельзя — иначе агент сам находит проблему, сам считает её важной и сам её
 * закрывает, а система лишается единственного места, где решение можно ограничить бюджетом.
 */
import type { ProjectFacts } from '../core/facts.ts';
import type { ConvergenceBudget, ConvergencePass, PolicySet } from '../core/types.ts';
import type { AdrDigest } from '../project/adr-digest.ts';
import {
  decisionsSection,
  machineFindingsSection,
  policiesSection,
  sizeSection,
  surfacesSection,
  toolsSection,
  treeSection,
} from './context.ts';
import type { WorkPacket } from './types.ts';

function schemaFor(policies: PolicySet): string {
  const categories = policies.maintenance.deepMaintenance.zones.flatMap((zone) =>
    zone.looksFor.map((kind) => kind.id),
  );
  return JSON.stringify(
    {
      findings: [
        {
          id: 'F1',
          category: categories.join(' | '),
          subject: 'стабильная сущность проблемы: символ, пара дубликатов или инвариант',
          title: 'одна строка: что не так',
          severity: 'high | medium | low',
          confidence: 0,
          files: ['путь/от/корня.ts'],
          evidence: 'что именно видно в коде: имена, строки, наблюдаемый факт',
          policy: 'id правила из architecture.yaml, если находка о его нарушении',
          relatedAdr: 'docs/adr/0000-имя.md, если решение есть',
          behaviorRisk: 'low | medium | high',
          suggestedAction: 'что сделать, одним-двумя предложениями',
          estimatedLines: 0,
        },
      ],
    },
    null,
    2,
  );
}

export interface ReviewerOptions {
  readonly facts: ProjectFacts;
  readonly policies: PolicySet;
  readonly budget: ConvergenceBudget;
  readonly pass: ConvergencePass;
  readonly outputFile: string;
  /** Выжимки решений области: их собирает вызывающий, потому что читать `docs/adr` ядру нельзя. */
  readonly decisions?: { readonly digests: readonly AdrDigest[]; readonly omitted: number };
}

export function reviewerPacket(options: ReviewerOptions): WorkPacket {
  const { facts, policies, budget, pass } = options;

  return {
    role: 'reviewer',
    goal: `Проход «${pass.id}». ${pass.goal.trim()}`,
    // Пустой список областью не ограничивает, а означает полный обзор: так его и читает
    // `renderPacket`. Подменять пустоту на пустоту было нечем — отдаём список как есть.
    scope: facts.scopeFiles,
    inputs: [
      treeSection(facts),
      toolsSection(facts),
      machineFindingsSection(facts),
      policiesSection(facts, policies),
      decisionsSection(options.decisions?.digests ?? [], options.decisions?.omitted ?? 0),
      surfacesSection(facts, policies),
      sizeSection(facts),
    ],
    constraints: [
      `Не больше ${budget.maxFindingsPerPass * 3} находок: система всё равно возьмёт в работу не более ${budget.maxFindingsPerPass}, а остальное станет очередью.`,
      'subject — краткая стабильная идентичность проблемы, а не заголовок и не доказательство. Для той же проблемы сохраняйте тот же символ, пару сущностей или имя инварианта при любом перефразировании.',
      'Каждая находка обязана иметь наблюдаемое доказательство: имя файла и то, что в нём видно. Догадка о намерении автора доказательством не является.',
      `Уверенность ставьте честно: ниже ${budget.minAutofixConfidence} находка не пойдёт в автоматическую правку, но останется в отчёте человеку. Завышенная уверенность — это не «помощь», а поломка отбора.`,
      'Риск для поведения оценивайте по худшему случаю: если правка теоретически способна изменить наблюдаемое поведение, это не `low`.',
      `Этот проход не занимается: ${pass.forbids.join(', ')}.`,
      'Область — перечисленные файлы. Если важная находка лежит за их пределами, опишите её отдельной находкой и честно укажите её файлы: расширять область самому не нужно.',
      'Для вида comments ищите устаревшие, бессмысленные и избыточные пересказы кода, а также неанглийские комментарии. Полезный комментарий должен самодостаточно объяснять инвариант, причину решения и последствия нарушения для следующего AI-агента; число строк само по себе не доказывает избыточность.',
    ],
    forbidden: [
      'Править код. Ответ этого задания — только описание находок.',
      'Предлагать изменения поведения продукта, UX, семантики API, бизнес-правил и схемы данных. Такое место описывается как находка с пометкой высокого риска и не чинится автоматически.',
      'Предлагать правку в областях `forbidden`.',
      'Изобретать правила. Ссылаться можно только на перечисленные выше или на наблюдаемое противоречие внутри кода.',
      'Дублировать то, что уже нашли линт, компилятор и статический разбор.',
      'Предлагать дробление файлов и функций ради числовых порогов.',
    ],
    expectedOutput:
      'Один JSON-объект со списком находок. Без текста вокруг, без пояснений до и после — только объект.',
    outputSchema: schemaFor(policies),
    outputFile: options.outputFile,
  };
}
