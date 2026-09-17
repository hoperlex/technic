/**
 * Типы предметной области системы обслуживания. Переносимая часть: ни один тип здесь не знает
 * ни этого репозитория, ни его команд.
 */

/**
 * Строгость правила.
 *
 * Три уровня, а не два, потому что двух не хватает: между «нарушение инварианта» и «дело вкуса»
 * лежит большой класс правил, которые стоит чинить, но только если выпал дешёвый случай. Слить
 * `soft` с `hard` значит остановить рефакторинг на первом же спорном месте; слить с `advisory` —
 * потерять его вовсе.
 */
export type Severity = 'hard' | 'soft' | 'advisory';

/** Кто исполняет правило. Нужно, чтобы не проверять второй раз уже проверенное машиной. */
export type Enforcer = 'eslint' | 'check-docs' | 'quality-budget' | 'tests' | 'ai-review' | 'human';

export type PolicyStatus = 'active' | 'draft' | 'retired';

/** Машинная часть архитектурного решения. Текст решения живёт в ADR и сюда не переезжает. */
export interface ArchitecturePolicy {
  readonly id: string;
  readonly title: string;
  readonly status: PolicyStatus;
  readonly severity: Severity;
  /** Маски путей, на которые правило распространяется. Пустой список — правило без области. */
  readonly scope: readonly string[];
  readonly enforcedBy: Enforcer;
  /** Файл-носитель правила, если исполняет его машина. */
  readonly source?: string;
  /** Ссылки на решения и протоколы — для человека и для контекста агента. */
  readonly adr: readonly string[];
  readonly autofix: boolean;
  /** Формулировка, которую читает агент-ревьюер. */
  readonly rule: string;
  /** Признак нарушения, если он неочевиден из формулировки. */
  readonly detect?: string;
  readonly notes?: string;
  readonly exceptionsRequireReason: boolean;
}

/**
 * Режим защищённой области.
 *
 * `manual-review` — не «почти можно»: система не принимает такую правку сама даже при зелёной
 * проверке. Она доводит её до предложения человеку и на этом останавливается.
 */
export type SurfaceMode = 'allowed' | 'manual-review' | 'forbidden';

export interface ProtectedSurface {
  readonly id: string;
  readonly mode: SurfaceMode;
  readonly paths: readonly string[];
  readonly why: string;
  readonly see: readonly string[];
}

/** Решение о пути: режим и правило, которым он назначен. */
export interface SurfaceVerdict {
  readonly path: string;
  readonly mode: SurfaceMode;
  /** `null` — путь не попал ни в одну область и действует умолчание. */
  readonly surface: ProtectedSurface | null;
  /** Маска, по которой произошло совпадение: без неё вердикт нечем объяснить человеку. */
  readonly matchedPattern: string | null;
}

/** Осознанное исключение из правила. Без причины и даты пересмотра не существует. */
export interface ArchitectureException {
  readonly id: string;
  readonly policy: string;
  readonly paths: readonly string[];
  readonly reason: string;
  readonly approvedBy?: string;
  readonly since?: string;
  readonly reviewBy?: string;
}

/** Пакет монорепозитория и разрешённые ему направления. */
export interface ModulePackage {
  readonly id: string;
  readonly path: string;
  readonly role: string;
  readonly publicApi?: string;
  readonly mayDependOn: readonly string[];
  readonly notes?: string;
}

/** Слой, за которым следит внешний носитель (линт). Здесь — указатель, а не копия правил. */
export interface LayerModel {
  readonly id: string;
  readonly scope: string;
  readonly enforcedBy: Enforcer;
  readonly source?: string;
  readonly order: readonly string[];
  readonly entry?: string;
  readonly notes?: string;
}

export interface ModuleMap {
  readonly packages: readonly ModulePackage[];
  readonly layers: readonly LayerModel[];
  readonly shared: readonly string[];
  readonly domains: readonly Domain[];
}

/**
 * Логическая область проекта. Состав приходит от провайдера — в этом репозитории его читают из
 * карты кода, в другом он может прийти откуда угодно.
 */
export interface Domain {
  readonly id: string;
  readonly title: string;
  /** Пути, относящиеся к домену, относительно корня репозитория. */
  readonly paths: readonly string[];
  /** Ссылки на решения домена. */
  readonly adr: readonly string[];
}

/** Бюджеты одного прохода и всего цикла. Решение об остановке принимает оркестратор, не модель. */
export interface ConvergencePass {
  readonly id: string;
  readonly goal: string;
  readonly forbids: readonly string[];
}

export interface ConvergenceBudget {
  readonly maxPasses: number;
  readonly maxFindingsPerPass: number;
  readonly maxFilesChanged: number;
  readonly maxChangedLines: number;
  readonly minAutofixConfidence: number;
  readonly allowedRisk: 'low' | 'medium' | 'high';
  readonly behaviorChanges: 'forbidden' | 'allowed';
  readonly passes: readonly ConvergencePass[];
}

export interface DeepMaintenanceZone {
  readonly id: string;
  readonly looksFor: readonly string[];
  readonly mayChange: readonly string[];
  readonly mustNotChange: readonly string[];
}

export interface DeepMaintenanceBudget {
  readonly enabled: boolean;
  /**
   * Бюджет НА ЗОНУ, а не на всё окно.
   *
   * Общий счётчик на окно оказался ложной мерой: ревьюер думает минутами, и съеденное им время
   * отнималось у исполнителя — окно закрывалось, не сделав ни одной правки в последней зоне. Время
   * отпускается зоне, а когда оно вышло, система не закрывается молча, а спрашивает человека.
   */
  readonly zoneMinutes: number;
  readonly maxRepairBatches: number;
  readonly maxFindingsPerBatch: number;
  readonly maxFilesPerBatch: number;
  readonly maxChangedLinesPerBatch: number;
  readonly fullScan: 'allowed' | 'forbidden';
  readonly zones: readonly DeepMaintenanceZone[];
}

export interface LedgerPolicy {
  readonly reopenOnCodeChange: boolean;
  readonly reopenOnPolicyChange: boolean;
  readonly deferredReviewDays: number;
  readonly falsePositiveReviewDays: number;
}

/** Условия старта прогона: насколько строго система требует стабильную точку. */
export interface StartPolicyConfig {
  readonly requireClean: boolean;
  readonly requireGreen: boolean;
}

export interface MaintenancePolicy {
  readonly runtimeHome: string;
  readonly start: StartPolicyConfig;
  readonly convergence: ConvergenceBudget;
  readonly deepMaintenance: DeepMaintenanceBudget;
  readonly ledger: LedgerPolicy;
  readonly stopConditions: readonly string[];
}

/** Всё, что система знает о правилах проекта, одним значением. */
export interface PolicySet {
  readonly policies: readonly ArchitecturePolicy[];
  readonly surfaces: readonly ProtectedSurface[];
  readonly surfaceDefault: SurfaceMode;
  readonly exceptions: readonly ArchitectureException[];
  readonly maintenance: MaintenancePolicy;
  readonly moduleMap: ModuleMap;
}

/**
 * Алиас путей проекта: `@shared/*` вместо `apps/web/src/shared/*`.
 *
 * `within` ограничивает область действия алиаса. Без него алиас портала распространился бы на
 * сервер, и одноимённый импорт там разрешился бы в чужой файл — граф зависимостей показал бы
 * связь, которой нет.
 */
export interface AliasEntry {
  readonly prefix: string;
  readonly target: string;
  readonly within?: string;
}
