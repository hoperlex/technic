/**
 * Конфигурация: единственное место, где переносимое ядро узнаёт про конкретный репозиторий.
 *
 * Всё project-specific обязано приходить сюда значением: пути, команды проверки, поставщик
 * доменов. Ядро не имеет права спрашивать `apps/` или `pnpm` напрямую — иначе вынос его во
 * внешнюю библиотеку означал бы переписывание.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DomainProvider } from './contracts.ts';
import type { AliasEntry } from './types.ts';
import { MaintenanceConfigError } from './errors.ts';

/**
 * Уровень проверки поведения.
 *
 * Уровней несколько, потому что проверки стоят по-разному: типы и тесты без базы идут минуты, а
 * db-набору нужна своя свежая база, и на общей он даёт ЛОЖНЫЕ падения. Ложное падение хуже
 * пропущенного: оно откатывает верную правку и учит человека не доверять проверке.
 */
export interface VerificationLevel {
  readonly id: string;
  readonly title: string;
  /** Команда и аргументы. Запускается как есть, без оболочки. */
  readonly command: readonly string[];
  /** Входит ли уровень в обычный прогон. Выключенный включается явным флагом. */
  readonly enabledByDefault: boolean;
  readonly why?: string;
}

/**
 * Чем добываются факты. Команды задаются данными, а не кодом: их печатают человеку в отчёте и
 * повторяют руками, разбирая находку. Токен `{out}` подставляется путём к временному файлу
 * машинного отчёта.
 */
export interface AnalysisConfig {
  readonly lintCommand: readonly string[];
  readonly typecheckCommand: readonly string[];
  readonly aliases: readonly AliasEntry[];
  readonly sourceExtensions: readonly string[];
  /** Сколько сообщений линта и самых больших файлов оставлять в фактах. */
  readonly keepLintMessages?: number;
  readonly keepLargestFiles?: number;
  readonly maxCycles?: number;
  /**
   * На сколько шагов по графу зависимостей расширять область вокруг изменённых файлов.
   *
   * Единица — прямые соседи. Ноль означал бы «смотреть только изменённое», а именно соседи и
   * ломаются: правка в общем модуле видна его потребителям, а не ему самому. Двойка на этом
   * дереве раздувает контекст до сотен файлов.
   */
  readonly neighbourDepth?: number;
  /** Потолок области: дальше расширять нельзя, иначе задание агенту перестаёт быть заданием. */
  readonly maxScopeFiles?: number;
  /**
   * Гонять ли проверку в отдельном рабочем дереве (`HEAD` + файлы партии).
   *
   * Без изоляции ворота идут по общему дереву, где лежит чужая незавершённая работа: красный шаг
   * соседа откатывает верную правку системы. Проверено трижды на живых прогонах — именно это и
   * помешало показать исход «принято».
   */
  readonly isolateVerification?: boolean;
  /**
   * Каталоги зависимостей, которые надо подложить в изолированное дерево.
   *
   * Переустанавливать их нельзя — это минуты и гигабайты. И подставить одной ссылкой тоже нельзя:
   * в pnpm свои пакеты слинкованы относительно, и ссылка на каталог основного дерева увела бы
   * сборку обратно в грязное дерево — молча. Подробности в `git/worktree.ts`.
   */
  readonly linkPaths?: readonly string[];
  /**
   * Сколько решений класть в задание ревьюеру и по сколько знаков от каждого.
   *
   * Потолок нужен по той же причине, по которой обрезан список файлов: на области бывает под три
   * десятка решений, и поданные целиком они дают сто двадцать килобайт — размер, на котором
   * задание перестаёт быть заданием.
   */
  readonly maxAdrInPacket?: number;
  readonly maxAdrChars?: number;
  /**
   * Сколько последних коммитов даёт область прогона в цехе.
   *
   * В цехе незакоммиченного нет, и «что изменено» там пусто по построению: областью становится
   * недавняя история. Больше десятка коммитов — это уже не «недавняя работа», а обзор.
   */
  readonly scopeCommits?: number;
  /**
   * Сколько минут файл считается горячим после последней правки на диске.
   *
   * Коммит не означает, что автор от файла оторвался: через минуту он может дописывать дальше.
   */
  readonly cooldownMinutes?: number;
}

/**
 * Кто относит задание агенту.
 *
 * `manual` — сегодняшний порядок: система пишет задание, человек отдаёт его агенту и приносит
 * ответ. `command` — система зовёт агента сама. Умолчание оставлено ручным намеренно: переключение
 * меняет не настройку, а то, кто держит руку на дереве, и такое решение принимает человек явно —
 * строкой в конфиге или флагом `--agent command`.
 */
export interface AgentConfig {
  readonly mode: 'manual' | 'command';
  /**
   * Путь к программе агента. `null` — найти самому: `PATH`, затем расширение редактора.
   *
   * Не строка в конфиге по умолчанию потому, что в редакторе программа лежит внутри расширения, а
   * путь туда содержит номер версии и меняется при каждом обновлении.
   */
  readonly binary?: string | null;
  /**
   * Аргументы РЕВЬЮЕРА. Правка ему запрещена не только словами задания, но и инструментами: он
   * ищет и описывает, а всё, что он мог бы поправить сам, обошло бы отбор и бюджет.
   */
  readonly reviewerArgs?: readonly string[];
  /**
   * Аргументы ИСПОЛНИТЕЛЯ. Ему правка разрешена — в этом его роль; границы держат не права
   * процесса, а контрольная точка, замок поведения и откат.
   */
  readonly fixerArgs?: readonly string[];
  /** Потолок ожидания. Ноль означал бы «ждать вечно», а зависший агент в цикле некому прервать. */
  readonly timeoutMs?: number;
  /** Печатать команду вместо запуска: первый запуск стоит посмотреть глазами. */
  readonly dryRun?: boolean;
}

/** Что система вообще рассматривает как свою область работы. */
export interface ScopeConfig {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** То, что пишет человек в `maintenance.config.ts`. */
/**
 * Цех: где система держит код, с которым работает.
 *
 * ПОЧЕМУ НЕ В РАБОЧЕМ ДЕРЕВЕ. Дерево здесь общее и не останавливается: рядом непрерывно правят
 * несколько сессий. Партия живёт десять-двадцать минут, и за это время чужая правка появляется
 * почти наверняка — а замок поведения обязан считать её поводом остановиться, потому что отличить
 * её от выхода исполнителя за границы партии нечем. Получался цикл, который в живом дереве не
 * может принять ничего.
 *
 * В цехе этой беды нет по построению: это отдельное дерево git от `HEAD`, где нет никого, кроме
 * системы. Рабочее дерево не трогается вовсе — ни файлом, ни индексом.
 */
export interface WorkshopConfig {
  readonly enabled: boolean;
  /**
   * Класть ли принятую партию в историю самой системой.
   *
   * Иначе правка осталась бы в цехе и до неё никто бы не дошёл: перенести её в рабочее дерево
   * нельзя — там чужая работа, — а жить вечно каталог цеха не может.
   */
  readonly commit?: boolean;
}

export interface MaintenanceConfigInput {
  /** Каталог машинного слоя архитектуры. По умолчанию `architecture`. */
  readonly architectureDir?: string;
  /** Рабочий каталог прогона. По умолчанию `.maintenance`; обязан быть в `.gitignore`. */
  readonly runtimeDir?: string;
  readonly domains?: DomainProvider;
  readonly verification: readonly VerificationLevel[];
  readonly scope: ScopeConfig;
  readonly analysis: AnalysisConfig;
  readonly agent?: AgentConfig;
  readonly workshop?: WorkshopConfig;
}

/** То, с чем работает ядро: пути уже разрешены относительно корня. */
export interface MaintenanceConfig {
  readonly root: string;
  readonly architectureDir: string;
  readonly runtimeDir: string;
  readonly files: {
    readonly modules: string;
    readonly policies: string;
    readonly protectedSurfaces: string;
    readonly exceptions: string;
    readonly maintenance: string;
  };
  readonly domains: DomainProvider | null;
  readonly verification: readonly VerificationLevel[];
  readonly scope: ScopeConfig;
  readonly analysis: AnalysisConfig;
  readonly agent?: AgentConfig;
  readonly workshop?: WorkshopConfig;
}

/**
 * Тот же конфиг, но код берётся из другого дерева.
 *
 * ПОЧЕМУ КОПИЯ, А НЕ ВТОРОЕ ПОЛЕ. Половина системы работает с кодом (линт, типы, контрольная
 * точка, правка агента), половина — с репозиторием (политики, рабочий каталог, история git). Дай
 * им одно поле `root` и отдельное `workRoot` — и каждый вызов пришлось бы читать с вопросом «а
 * этот про какое из двух?». Копия отвечает на вопрос типом: кому передали дерево цеха, тот про
 * код; у кого исходный конфиг, тот про репозиторий.
 *
 * Всё остальное в конфиге — абсолютные пути к настоящему репозиторию, и копия их не меняет:
 * политики, рабочий каталог и файлы архитектуры остаются там, где лежали.
 */
export function inTree(config: MaintenanceConfig, treePath: string): MaintenanceConfig {
  return { ...config, root: treePath };
}

/**
 * Опознание конфига при написании. Функция ничего не делает специально: её работа — дать
 * редактору тип и не дать конфигу разойтись с ядром молча.
 */
export function defineMaintenanceConfig(input: MaintenanceConfigInput): MaintenanceConfigInput {
  return input;
}

export function resolveConfig(root: string, input: MaintenanceConfigInput): MaintenanceConfig {
  const architectureDir = input.architectureDir ?? 'architecture';
  const runtimeDir = input.runtimeDir ?? '.maintenance';
  const policies = path.join(root, architectureDir, 'policies');
  return {
    root,
    architectureDir: path.join(root, architectureDir),
    runtimeDir: path.join(root, runtimeDir),
    files: {
      modules: path.join(root, architectureDir, 'modules.yaml'),
      policies: path.join(policies, 'architecture.yaml'),
      protectedSurfaces: path.join(policies, 'protected-surfaces.yaml'),
      exceptions: path.join(policies, 'exceptions.yaml'),
      maintenance: path.join(policies, 'maintenance.yaml'),
    },
    domains: input.domains ?? null,
    verification: input.verification,
    scope: input.scope,
    analysis: input.analysis,
    agent: input.agent,
    workshop: input.workshop,
  };
}

/**
 * Загрузка конфига из корня репозитория.
 *
 * Конфиг — модуль, а не данные: он связывает ядро с поставщиками этого проекта, и связать их
 * значением JSON нечем. Это тот же приём, что у `eslint.config.mjs` в этом репозитории.
 */
export async function loadConfig(
  root: string,
  fileName = 'maintenance.config.ts',
): Promise<MaintenanceConfig> {
  const file = path.join(root, fileName);
  let module: unknown;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (cause) {
    throw new MaintenanceConfigError(fileName, `не удалось загрузить: ${(cause as Error).message}`);
  }
  const input = (module as { default?: unknown }).default;
  if (input === undefined || input === null || typeof input !== 'object') {
    throw new MaintenanceConfigError(fileName, 'файл обязан экспортировать конфиг по умолчанию');
  }
  const candidate = input as Partial<MaintenanceConfigInput>;
  if (!Array.isArray(candidate.verification)) {
    throw new MaintenanceConfigError(fileName, 'поле verification обязано быть списком уровней');
  }
  if (candidate.scope === undefined) {
    throw new MaintenanceConfigError(
      fileName,
      'поле scope обязательно: без него область работы неизвестна',
    );
  }
  return resolveConfig(root, candidate as MaintenanceConfigInput);
}
