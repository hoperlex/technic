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
import type { AdrDigest } from '../project/adr-digest.ts';

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

/**
 * Решения, действующие в области работы.
 *
 * ЗАЧЕМ ОНИ В ЗАДАНИИ. Раньше система считала, какие решения относятся к затронутым файлам, и
 * печатала их ЧИСЛО человеку — а до ревьюера не доходило ни строчки. Агент судил о коде, не зная
 * договорённостей, по которым код написан, и предлагал «починить» ровно то, что кто-то однажды
 * решил сделать именно так.
 *
 * Подаются не решения целиком, а их ведущие утверждения: раздел «Решение» здесь — нумерованный
 * свод правил, и именно он нужен ревьюеру. История вопроса остаётся в файле, ссылка на него — в
 * заголовке пункта.
 */
export function decisionsSection(digests: readonly AdrDigest[], omitted: number): PacketSection {
  if (digests.length === 0) {
    return {
      title: 'Решения, действующие здесь',
      body: 'К затронутым файлам решений не привязано.',
    };
  }
  const body = digests
    .map((digest) => {
      const head = `### ${digest.number} — ${digest.title}`;
      const meta = `Статус: ${digest.status}. Домены: ${digest.domains.join(', ') || 'не назначены'}. Файл: ${digest.path}`;
      return `${head}\n${meta}\n${digest.essence.trim()}`;
    })
    .join('\n\n');
  const tail =
    omitted === 0
      ? ''
      : `\n\n_Показаны ${digests.length}; ещё ${omitted} решений области не поместились — их список в снимке фактов._`;
  return {
    title: 'Решения, действующие здесь',
    body: `${body}${tail}\n\nЭто договорённости, а не код. Находка, предлагающая сделать иначе, обязана\nссылаться на решение и объяснять, почему оно устарело, — иначе это не находка, а его отмена\nмимо человека.`,
  };
}
