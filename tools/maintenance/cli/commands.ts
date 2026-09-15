/**
 * Команды первого этапа. Каждая — тонкая оболочка над внутренним API: бизнес-логики здесь нет,
 * и это условие переносимости. Команда собирает значения, зовёт ядро и печатает результат.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { MaintenanceConfig } from '../core/config.ts';
import type { Reporter } from '../core/contracts.ts';
import type { PolicySet, Severity } from '../core/types.ts';
import { YamlPolicyProvider } from '../policies/provider.ts';
import { resolveSurface } from '../policies/surfaces.ts';
import { ensureWorkspace, isIgnoredByGit } from '../state/workspace.ts';
import { lastChangeOf } from '../analyzers/git.ts';

/** Итог команды: код возврата и есть ответ, всё остальное уже напечатано. */
export type CommandResult = { readonly ok: boolean };

const SEVERITY_ORDER: readonly Severity[] = ['hard', 'soft', 'advisory'];

export async function loadPolicies(config: MaintenanceConfig): Promise<PolicySet> {
  return new YamlPolicyProvider(config).load();
}

/**
 * Проверка исправности самой системы: конфиг, рабочий каталог, политики, карта.
 *
 * Отдельная команда, а не молчаливая проверка внутри остальных: поломка политики обязана быть
 * видна ДО того, как система начнёт что-то советовать. Правило, потерянное опечаткой, не
 * проявляется ничем — всё зелено, просто правил стало меньше.
 */
export async function doctor(config: MaintenanceConfig, out: Reporter): Promise<CommandResult> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const rel = (file: string) => path.relative(config.root, file);

  out.heading('рабочий каталог');
  const workspace = ensureWorkspace(config.runtimeDir);
  out.item(`${rel(workspace.home)}/ — создан`);
  if (isIgnoredByGit(config.root, config.runtimeDir)) {
    out.item('вне истории: git его игнорирует');
  } else {
    // Не предупреждение, а ошибка: производное состояние в публичном репозитории — то самое, от
    // чего отделён этот каталог.
    problems.push(`${rel(config.runtimeDir)} НЕ игнорируется git — добавьте его в .gitignore`);
  }

  out.heading('политики');
  const policies = await loadPolicies(config);
  const bySeverity = new Map<Severity, number>();
  for (const policy of policies.policies) {
    if (policy.status !== 'active') continue;
    bySeverity.set(policy.severity, (bySeverity.get(policy.severity) ?? 0) + 1);
  }
  out.item(
    `правил: ${policies.policies.length} (` +
      SEVERITY_ORDER.map((severity) => `${severity} ${bySeverity.get(severity) ?? 0}`).join(', ') +
      ')',
  );
  out.item(
    `защищённых областей: ${policies.surfaces.length}, умолчание — ${policies.surfaceDefault}`,
  );
  out.item(`исключений: ${policies.exceptions.length}`);
  out.item(
    `бюджет цикла: ${policies.maintenance.convergence.maxPasses} прохода, ` +
      `${policies.maintenance.convergence.maxFilesChanged} файлов, ` +
      `${policies.maintenance.convergence.maxChangedLines} строк, ` +
      `уверенность от ${policies.maintenance.convergence.minAutofixConfidence}`,
  );
  out.item(
    `тяжёлое окно: ${policies.maintenance.deepMaintenance.enabled ? 'включено' : 'выключено'}, ` +
      `${policies.maintenance.deepMaintenance.windowMinutes} минут`,
  );

  // Когда последний раз правили сам файл политик: с этой датой сравниваются даты решений ниже.
  const policyChanged = lastChangeOf(
    config.root,
    path.relative(config.root, config.files.policies),
  );

  // Носитель правила, которого нет в дереве, — это правило, за которым никто не следит. Ссылка на
  // несуществующее решение — то же самое для человека.
  for (const policy of policies.policies) {
    if (policy.source !== undefined && !existsSync(path.join(config.root, policy.source))) {
      problems.push(`правило ${policy.id}: носителя ${policy.source} нет в дереве`);
    }
    for (const link of policy.adr) {
      if (!existsSync(path.join(config.root, link))) {
        problems.push(`правило ${policy.id}: ссылки ${link} нет в дереве`);
      }
    }

    /*
     * ОБРАТНАЯ СВЕРКА ПРАВИЛА И РЕШЕНИЯ (решение заказчика 15.09.2026).
     *
     * Машинный слой правил живёт рядом с решениями, а не внутри них, и связь между ними до сих пор
     * была односторонней: правило называло решение, а обратно никто не смотрел. Два молчаливых
     * расхождения из этого следовали.
     *
     * Первое: жёсткое правило без единой ссылки на решение. Строгость `hard` означает «нарушать
     * нельзя», и такое утверждение обязано иметь записанное обоснование — иначе это мнение автора
     * политики, которое некому оспорить.
     *
     * Второе: решение, изменённое ПОЗЖЕ правила. Текст решения переписали, а машинную часть не
     * тронули — и правило продолжает стеречь вчерашнюю договорённость. Проверяется историей git, а
     * не временем файла: время сбрасывается любой выгрузкой дерева.
     */
    if (policy.severity === 'hard' && policy.adr.length === 0) {
      /*
       * Предупреждение, а не ошибка, и это разница по существу. Ошибка означает «система
       * неисправна и работать не должна» — а здесь неисправен не механизм, а обоснование: правило
       * стережёт верную вещь, но записанного решения за ним нет. Роняя прогон, мы бы заставили
       * человека либо писать решение под давлением, либо снять правило — оба исхода хуже, чем
       * видимый долг.
       */
      warnings.push(
        `правило ${policy.id}: строгость hard без ссылки на решение — обоснование не записано`,
      );
    }
    for (const link of policy.adr) {
      const adrChanged = lastChangeOf(config.root, link);
      if (adrChanged === null || policyChanged === null) continue;
      if (adrChanged > policyChanged) {
        warnings.push(
          `правило ${policy.id}: решение ${link} правили позже правила — сверьте, не отстало ли оно`,
        );
      }
    }
  }

  // Точные пути защищённых областей проверяются на существование, маски — нет: маска и написана
  // для того, чтобы покрывать ещё не созданные файлы.
  for (const surface of policies.surfaces) {
    for (const item of surface.paths) {
      if (item.includes('*')) continue;
      if (!existsSync(path.join(config.root, item))) {
        warnings.push(`область ${surface.id}: путь ${item} не существует — маска устарела?`);
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const exception of policies.exceptions) {
    if (exception.reviewBy !== undefined && exception.reviewBy < today) {
      warnings.push(`исключение ${exception.id}: срок пересмотра истёк ${exception.reviewBy}`);
    }
  }

  out.heading('карта модулей');
  out.item(
    `пакетов: ${policies.moduleMap.packages.length}, слоёв: ${policies.moduleMap.layers.length}`,
  );
  out.item(
    policies.moduleMap.domains.length > 0
      ? `доменов: ${policies.moduleMap.domains.length} (источник — ${config.domains?.id ?? 'не задан'})`
      : 'доменов нет: поставщик не задан в конфиге',
  );
  for (const item of policies.moduleMap.packages) {
    if (!existsSync(path.join(config.root, item.path))) {
      problems.push(`пакет ${item.id}: каталога ${item.path} нет в дереве`);
    }
    if (item.publicApi !== undefined && !existsSync(path.join(config.root, item.publicApi))) {
      problems.push(`пакет ${item.id}: публичного входа ${item.publicApi} нет в дереве`);
    }
  }

  out.heading('проверка поведения');
  for (const level of config.verification) {
    out.item(
      `${level.id}: ${level.command.join(' ')} — ${level.enabledByDefault ? 'в обычном прогоне' : 'по флагу'}`,
    );
  }
  if (!config.verification.some((level) => level.enabledByDefault)) {
    problems.push(
      'ни один уровень проверки не включён по умолчанию: доказывать сохранение поведения нечем',
    );
  }

  out.heading('итог');
  for (const text of warnings) out.warn(text);
  for (const text of problems) out.error(text);
  if (problems.length === 0) {
    out.item(warnings.length === 0 ? 'исправно' : `исправно, замечаний: ${warnings.length}`);
  }
  return { ok: problems.length === 0 };
}

/** Перечень правил. `--severity hard` — только жёсткие. */
export async function showPolicies(
  config: MaintenanceConfig,
  out: Reporter,
  filter: Severity | null,
): Promise<CommandResult> {
  const policies = await loadPolicies(config);
  for (const severity of SEVERITY_ORDER) {
    if (filter !== null && filter !== severity) continue;
    const selected = policies.policies.filter((policy) => policy.severity === severity);
    if (selected.length === 0) continue;
    out.heading(`${severity} — ${selected.length}`);
    for (const policy of selected) {
      const status = policy.status === 'active' ? '' : ` [${policy.status}]`;
      out.item(
        `${policy.id}${status} · исполняет: ${policy.enforcedBy}${policy.autofix ? '' : ' · автоправка запрещена'}`,
      );
      out.line(`      ${policy.title}`);
      if (policy.scope.length > 0) out.line(`      область: ${policy.scope.join(', ')}`);
    }
  }
  return { ok: true };
}

/** Режим защищённой области для перечисленных путей. */
export async function showSurfaces(
  config: MaintenanceConfig,
  out: Reporter,
  paths: readonly string[],
): Promise<CommandResult> {
  const policies = await loadPolicies(config);
  if (paths.length === 0) {
    out.heading(`защищённые области (умолчание — ${policies.surfaceDefault})`);
    for (const surface of policies.surfaces) {
      out.item(`${surface.mode.padEnd(13)} ${surface.id}`);
      for (const item of surface.paths) out.line(`      ${item}`);
    }
    return { ok: true };
  }
  out.heading('решение по путям');
  for (const item of paths) {
    const verdict = resolveSurface(config.root, policies.surfaces, policies.surfaceDefault, item);
    const reason =
      verdict.surface === null
        ? 'умолчание'
        : `${verdict.surface.id} по маске ${verdict.matchedPattern ?? '—'}`;
    out.item(`${verdict.mode.padEnd(13)} ${verdict.path}  ← ${reason}`);
  }
  return { ok: true };
}

/** Карта модулей: пакеты, направления, слои и домены. */
export async function showModules(
  config: MaintenanceConfig,
  out: Reporter,
): Promise<CommandResult> {
  const policies = await loadPolicies(config);
  out.heading('пакеты');
  for (const item of policies.moduleMap.packages) {
    const allowed = item.mayDependOn.length > 0 ? item.mayDependOn.join(', ') : 'ничего';
    out.item(`${item.id.padEnd(10)} ${item.path.padEnd(24)} ${item.role.padEnd(16)} → ${allowed}`);
  }
  out.heading('слои');
  for (const layer of policies.moduleMap.layers) {
    out.item(`${layer.id}: ${layer.order.join(' → ')}`);
    out.line(
      `      область ${layer.scope}, исполняет ${layer.enforcedBy}${layer.source ? ` (${layer.source})` : ''}`,
    );
  }
  out.heading(`домены — ${policies.moduleMap.domains.length}`);
  for (const domain of policies.moduleMap.domains) {
    out.item(
      `${domain.id.padEnd(20)} путей: ${String(domain.paths.length).padStart(2)}  решений: ${domain.adr.length}  ${domain.title}`,
    );
  }
  out.heading('общие области');
  for (const item of policies.moduleMap.shared) out.item(item);
  return { ok: true };
}
