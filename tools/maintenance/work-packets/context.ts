/**
 * Сборка контекста для заданий: одни и те же факты, одинаково пересказанные.
 *
 * Пересказ нужен потому, что агент читает текст, а факты — машинный объект. Важно, чтобы пересказ
 * был ОДИН: разойдись формулировки в задании ревьюеру и исполнителю, они будут работать с разными
 * картинами одного дерева.
 */
import type { ProjectFacts } from '../core/facts.ts';
import type { PolicySet } from '../core/types.ts';
import type { PacketSection } from './types.ts';

export function treeSection(facts: ProjectFacts): PacketSection {
  const git = facts.git;
  return {
    title: 'Состояние дерева',
    body: [
      `Ветка \`${git.branch}\`, вершина \`${git.head.slice(0, 8)}\`.`,
      git.clean
        ? 'Дерево чистое.'
        : `В дереве ${git.changedFiles.length} изменённых файлов и ${git.untrackedFiles.length} неотслеживаемых — часть из них принадлежит чужой незавершённой работе.`,
      `Снимок фактов собран ${facts.collectedAt}.`,
    ].join(' '),
  };
}

export function toolsSection(facts: ProjectFacts): PacketSection {
  const topRules = Object.entries(facts.lint.byRule)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([rule, count]) => `${rule}: ${count}`)
    .join(', ');
  return {
    title: 'Что уже сказали инструменты',
    body: [
      `Линт: ${facts.lint.summary}${topRules === '' ? '' : ` (${topRules})`}.`,
      `Типы: ${facts.typecheck.summary}.`,
      facts.tests.skipped === undefined
        ? `Тесты: ${facts.tests.summary}.`
        : // Пропуск тестов — не строка итога, а другая новость: агент не должен читать «шаг не
          // выполнялся» как «поведение подтверждено». Про то, чего никто не проверял, он обязан
          // знать заранее — иначе он обопрётся на несуществующую зелёную проверку.
          `Тесты не запускались (${facts.tests.skipped}) — считать поведение подтверждённым нечем.`,
      `Зависимости: ${facts.dependencies.summary}.`,
      '',
      'Это уже известно системе. Повторять находки, которые видит линт или компилятор, не нужно:',
      'их чинят своими средствами. Ценность ревью — в том, чего машина не видит.',
    ].join('\n'),
  };
}

export function machineFindingsSection(facts: ProjectFacts): PacketSection {
  if (facts.dependencies.violations.length === 0) {
    return {
      title: 'Найдено статическим разбором',
      body: 'Нарушений направлений и циклов не найдено.',
    };
  }
  const lines = facts.dependencies.violations.slice(0, 20).map((violation) => {
    const files = violation.files.slice(0, 4).join(', ');
    return `- [${violation.severity}] ${violation.kind}: ${violation.detail} — ${files}`;
  });
  return {
    title: 'Найдено статическим разбором',
    body: [
      ...lines,
      '',
      'Эти места уже зафиксированы. Опишите их, только если видите причину, а не сам факт.',
    ].join('\n'),
  };
}

export function policiesSection(facts: ProjectFacts, policies: PolicySet): PacketSection {
  const relevant = policies.policies.filter(
    (policy) => policy.status === 'active' && facts.relevance.policies.includes(policy.id),
  );
  if (relevant.length === 0) {
    return {
      title: 'Правила, действующие здесь',
      body: 'Для затронутых файлов правил не назначено.',
    };
  }
  const body = relevant
    .map((policy) => {
      const head = `### ${policy.id} — ${policy.severity}, исполняет ${policy.enforcedBy}`;
      const rule = policy.rule.trim();
      const detect =
        policy.detect === undefined ? '' : `\nПризнак нарушения: ${policy.detect.trim()}`;
      const adr = policy.adr.length === 0 ? '' : `\nРешения: ${policy.adr.join(', ')}`;
      return `${head}\n${policy.title}.\n${rule}${detect}${adr}`;
    })
    .join('\n\n');
  return {
    title: 'Правила, действующие здесь',
    body: [
      body,
      '',
      'Правило со строгостью `advisory` поводом к правке не является: о нём можно сообщить, но',
      'предлагать по нему изменения не нужно. Правило, которое исполняет линт или проверка',
      'документации, уже проверено машиной — искать его нарушения вручную не требуется.',
    ].join('\n'),
  };
}

export function surfacesSection(facts: ProjectFacts, policies: PolicySet): PacketSection {
  const lines = policies.surfaces
    .filter((surface) => surface.mode !== 'allowed')
    .map(
      (surface) =>
        `- **${surface.mode}** ${surface.id}: ${surface.paths.join(', ')}\n  ${surface.why.trim()}`,
    );
  const touched = facts.relevance.surfaces.map(
    (item) => `- ${item.file} → ${item.mode} (${item.surface})`,
  );
  return {
    title: 'Защищённые области',
    body: [
      ...lines,
      '',
      touched.length === 0
        ? 'Ни один файл области работы в защищённые зоны не попадает.'
        : ['Файлы области, попавшие под ограничение:', ...touched].join('\n'),
      '',
      '`forbidden` — правку не предлагать вовсе: такая находка становится пунктом для человека.',
      '`manual-review` — находку описать можно, но исправлять её будет человек.',
    ].join('\n'),
  };
}

export function sizeSection(facts: ProjectFacts): PacketSection {
  const lines = facts.metrics.largest
    .slice(0, 10)
    .map(
      (item) => `- ${item.file}: ${item.codeLines} строк кода, ${item.commentLines} комментариев`,
    );
  return {
    title: 'Крупнейшие файлы области',
    body: [
      ...lines,
      '',
      'Размер — сигнал, а не цель. Дробить файл ради числа запрещено: повод к разбору появляется',
      'тогда, когда в файле видно несколько несвязанных ответственностей. Комментарии посчитаны',
      'отдельно и долгом не считаются.',
    ].join('\n'),
  };
}
