/**
 * Цех прогона: где система работает с кодом и как принятое попадает в историю.
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ ФАЙЛ. Всё здесь отвечает на один вопрос — «в каком дереве мы сейчас и что с
 * ним делать»: открыть, прицелиться, передать принятое, убрать за собой. Цикл сходимости про это
 * знать не обязан: ему нужно лишь «вот конфиг, вот область, вот решение».
 */
import path from 'node:path';
import type { MaintenanceConfig } from '../core/config.ts';
import { inTree } from '../core/config.ts';
import type { Reporter } from '../core/contracts.ts';
import type { RunState } from '../core/run-state.ts';
import type { TrackedFinding } from '../core/finding.ts';
import { changedSince, coolScope } from '../analyzers/git.ts';
import { disposeTreeAt, openWorkshop } from '../git/worktree.ts';
import { handOff } from '../git/handoff.ts';
import type { Workspace } from '../state/workspace.ts';
import type { BatchState } from './verify.ts';

/** Сколько последних коммитов даёт область в цехе: рабочий день одной сессии. */
const DEFAULT_SCOPE_COMMITS = 10;

/** Сколько минут файл считается горячим после последней правки на диске. */
const DEFAULT_COOLDOWN_MINUTES = 10;

export function workOf(config: MaintenanceConfig, state: RunState): MaintenanceConfig {
  const workshop = state.workshop;
  return workshop ? inTree(config, workshop.path) : config;
}

/**
 * Открыть цех под прогон.
 *
 * Отказ цеха не останавливает прогон: система честно говорит, что работает прямо в рабочем дереве,
 * и дальше действует по-старому. Молчаливый переход был бы хуже отказа — человек считал бы, что
 * чужая работа ему не помешает, а она помешает.
 */
export function openWorkshopFor(
  config: MaintenanceConfig,
  workspace: Workspace,
  state: RunState,
  out: Reporter,
): RunState {
  if (config.workshop?.enabled !== true) return state;
  try {
    const tree = openWorkshop({
      root: config.root,
      home: path.join(workspace.tmp, 'workshop'),
      linkPaths: config.analysis.linkPaths ?? [],
    });
    out.item(`цех: отдельное дерево от ${tree.base.slice(0, 8)}, рабочее дерево не трогаем`);
    return { ...state, workshop: { path: tree.path, base: tree.base } };
  } catch (error) {
    out.warn(`цех не открылся (${(error as Error).message}): работаем в рабочем дереве`);
    return state;
  }
}

/** Снести цех прогона. Зовётся отовсюду, где прогон кончается: завершением или снятием. */
export function closeWorkshop(config: MaintenanceConfig, state: RunState, out: Reporter): void {
  const workshop = state.workshop;
  if (!workshop) return;
  try {
    disposeTreeAt(config.root, workshop.path);
    out.item('цех убран');
  } catch (error) {
    out.warn(`цех не убрался: ${(error as Error).message}`);
  }
}

/**
 * Куда смотрит проход.
 *
 * Без цеха — по-старому: всё, что изменено относительно `HEAD`, включая рабочее дерево. С цехом
 * незакоммиченного нет по построению, да и целиться в него незачем: прицел переворачивается на
 * остывшее (`coolScope`), а горячее — чужая работа прямо сейчас — из области исключается и
 * называется человеку.
 *
 * `null` означает «git не ответил»: прогон обязан остановиться, потому что пустой список ниже по
 * течению читается как полный обзор.
 */
export function aimAt(config: MaintenanceConfig, state: RunState, out: Reporter): string[] | null {
  if (!state.workshop) {
    const changed = changedSince(config.root, 'HEAD');
    if (changed === null) {
      out.error('git не смог показать изменения рабочего дерева: прогон остановлен');
      return null;
    }
    return changed;
  }
  const cool = coolScope(config.root, {
    commits: config.analysis.scopeCommits ?? DEFAULT_SCOPE_COMMITS,
    cooldownMinutes: config.analysis.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES,
  });
  if (cool === null) {
    out.error('git не смог показать историю: прогон остановлен');
    return null;
  }
  out.item(
    `прицел: ${cool.files.length} остывших файлов из последних коммитов; горячих пропущено: ${cool.hot.length}`,
  );
  if (cool.files.length === 0) {
    out.warn('всё остывшее уже разобрано или занято чужой работой — смотреть нечего');
  }
  return [...cool.files];
}

/**
 * Отдать принятую партию в историю.
 *
 * ПОЧЕМУ ЭТО ЧАСТЬ ПРИЁМА, А НЕ ОТДЕЛЬНАЯ КОМАНДА. Правка, принятая в цехе, лежит в каталоге,
 * который система снесёт в конце прогона. Не передав её сразу, мы гарантированно её потеряем —
 * причём молча, отчитавшись «принято».
 *
 * Без цеха передавать нечего: правка и так в рабочем дереве, а коммитить за человека система не
 * вправе — это его работа и его история.
 */
export function passOn(
  config: MaintenanceConfig,
  state: RunState,
  batch: BatchState,
  findings: readonly TrackedFinding[],
  out: Reporter,
): void {
  const workshop = state.workshop;
  if (!workshop || config.workshop?.commit === false) return;

  const result = handOff({
    root: config.root,
    tree: workshop.path,
    base: workshop.base,
    files: batch.allowed,
    message: commitMessage(findings, batch),
    keepRef: `refs/maintenance/${state.runId}`,
  });

  if (result.sha === null) {
    out.warn(`партия принята, но в историю не легла: ${result.problem}`);
    return;
  }
  out.item(`коммит ${result.sha.slice(0, 8)} в ${result.branch}`);
  if (result.synced.length > 0) {
    out.item(`в рабочем дереве обновлено файлов: ${result.synced.length}`);
  }
  if (result.busy.length > 0) {
    // Не ошибка: это чужая работа поверх тех же файлов. Система её не трогает и говорит, каких
    // файлов рабочее дерево не получило, — сверять их человеку.
    out.warn(`заняты чужой работой, в дереве не обновлены: ${result.busy.join(', ')}`);
  }
  if (result.problem !== null) out.warn(result.problem);
}

/**
 * Сообщение коммита партии.
 *
 * Заголовок — по первой находке, тело — перечнем: человек, разбирающий историю через месяц,
 * обязан понять, что это сделала система и по какому поводу, не открывая её отчётов.
 */
function commitMessage(findings: readonly TrackedFinding[], batch: BatchState): string {
  const first = findings[0];
  const head = first ? first.title : `партия из ${batch.allowed.length} файлов`;
  const lines = [
    `refactor(maintain): ${head.toLowerCase()}`,
    '',
    'Правка цикла обслуживания кодовой базы: сделана и проверена в отдельном дереве от HEAD,',
    'ворота прогнаны там же. Находки прохода:',
    '',
    ...findings.map((finding) => `- ${finding.id} ${finding.title}`),
    '',
    'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
  ];
  return lines.join('\n');
}
