import { ATTESTATION_MAX_AGE_MS } from '../src/services/assignment-mode';
import type { AssignmentReadMode, AssignmentWriteMode } from '../src/services/assignment-mode';
import type { CutoverObstacle } from '../src/services/assignment-readiness';

/**
 * Что предстоит сделать в окне переключения — посчитанное **до** первой записи.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ КОМАНДЫ. Порядок шагов cutover — предмет решения (§10 плана
 * `docs/assignment-periods-plan.md`), а не последовательность вызовов в `main`. Пока он жил
 * порядком абзацев runbook, его исполняли руками, и каждая перестановка стоила окна: поколение,
 * снятое до заморозки, доказывает состояние, которое успело измениться. Здесь он записан
 * функцией — то есть его можно проверить тестом, не поднимая ни базы, ни портала.
 *
 * ЧТО ЭТО НЕ РЕШАЕТ. Ни одной проверки двери: матрица переходов, готовность популяции, поколение и
 * аттестация живут в `assignment-mode.ts` и считаются под блокировкой, в одной транзакции с
 * записью. Здесь — предполётный разбор: те же факты, прочитанные заранее, чтобы об отказе не
 * узнавали на середине окна, когда портал уже заморожен. Отказ отсюда означает «не начинаем», а не
 * «нельзя».
 *
 * ПОЧЕМУ АТТЕСТАЦИЮ КОМАНДА НЕ СНИМАЕТ САМА. Разрешение переключаться и его обоснование обязаны
 * исходить от разных рук (О4): аттестацию пишет тот, кто раскатывал, своей ролью
 * (`DATABASE_DEPLOY_URL`), а переключение её только потребляет. Обёртка, снимающая аттестацию себе
 * же, вернула бы круговую проверку — оператор объявляет себе, что раскат в порядке, и сам себе
 * верит. Поэтому идентификатор приходит аргументом, а его пригодность здесь только проверяется.
 */

/**
 * Аттестация в том виде, в каком её разбирает предполёт.
 *
 * Своя форма, а не `AttestationState` сводки: та отдаёт **последнюю непотреблённую**, а здесь
 * разбирается именно та, которую назвал оператор, — со всеми причинами, по которым она может не
 * годиться, включая уже потреблённую. Спрашивать «последнюю» вместо названной значило бы
 * переключиться не той бумагой, которую человек держит в руках.
 */
export interface CutoverAttestation {
  id: string;
  attestedAt: Date;
  consumedAt: Date | null;
  activeBuildShas: string[];
  algoVersion: string;
  legacyClientCalls: number;
}

/** Шаг окна. Порядок значений — порядок исполнения, и он же порядок §10. */
export type CutoverStep = 'freeze' | 'revalidate' | 'shadow' | 'verify' | 'switch' | 'unfreeze';

export interface CutoverSituation {
  /** Управляющая строка модуля; её отсутствие — отказ, а не «пусто» (И3). */
  controlRow: { writeMode: AssignmentWriteMode; readMode: AssignmentReadMode } | null;
  /** Ярус `data` сводки: история доведена у всей популяции. */
  dataReady: boolean;
  /** Препятствия яруса `data` — их называют человеку вместо общего «не готово». */
  dataObstacles: readonly CutoverObstacle[];
  /** Аттестация, названная оператором: её ищут по идентификатору, а не «последнюю свежую». */
  attestation: CutoverAttestation | null;
  /**
   * Требуется ли аттестация прямо сейчас.
   *
   * У окна (`run`) — да, всегда: без неё дверь не откроется. У предполётного осмотра (`status`) её
   * законно ещё нет — её снимают перед самым окном, — и отвечать «аттестация не найдена» на
   * вопрос «что мне предстоит» значило бы называть отказом порядок работ.
   */
  attestationRequired: boolean;
  /** Версия алгоритма этой сборки — с ней сверяется аттестация (О4). */
  algoVersion: string;
  /** Сборка, которой переключают: она обязана стоять в инвентаре раската. */
  buildSha: string;
  now: Date;
  /** Оператор попросил оставить заморозку: тогда разморозка — его отдельный шаг. */
  keepFrozen: boolean;
}

export interface CutoverPlan {
  /** Что делать по шагам; пусто — делать нечего (см. `notes`) либо отказ (см. `refusal`). */
  steps: CutoverStep[];
  /** Почему не начинаем. Непусто — команда не трогает ни режима, ни данных. */
  refusal: string | null;
  /**
   * Препятствия, стоящие за отказом, — как их назвала сводка, вместе с их собственным путём.
   *
   * Своего совета отказ не даёт намеренно: у препятствий яруса `data` пути разные — пустую историю
   * достраивает массовый прогон, пробелы машиниста чинит диспетчер дверью ремонта, а расхождение
   * поколения разбирают по одной цели. Один общий совет отправлял бы две трети случаев не туда.
   */
  blocking: readonly CutoverObstacle[];
  /** Что человеку стоит знать до начала: предупреждения, не запирающие окно. */
  notes: string[];
}

/**
 * Запас годности аттестации, с которым окно ещё можно начинать.
 *
 * Аттестация живёт полчаса и потребляется однажды, а между её снятием и переключением лежат
 * ревалидация и полное теневое сравнение — на боевой популяции это минуты, а не секунды. Начать с
 * почти истёкшей аттестацией значит гарантированно упереться в отказ двери **после** заморозки,
 * то есть с закрытым порталом и в тот момент, когда счёт идёт на минуты. Десять минут — не норма
 * годности (она в `ATTESTATION_MAX_AGE_MS`), а запас на саму работу окна.
 */
export const ATTESTATION_MIN_REMAINING_MS = 10 * 60 * 1000;

/** Сколько аттестации осталось жить; отрицательное значение — уже протухла. */
export function attestationRemainingMs(attestation: CutoverAttestation, now: Date): number {
  return attestation.attestedAt.getTime() + ATTESTATION_MAX_AGE_MS - now.getTime();
}

function minutes(ms: number): string {
  return `${Math.max(0, Math.round(ms / 60000))} мин`;
}

/**
 * Разложить окно на шаги по тому, что уже сделано.
 *
 * Правило одно и оно даёт всю таблицу исходов: каждый шаг пропускается, если его результат уже
 * достигнут, и делается во всех остальных случаях. Отсюда и возобновляемость — повторный запуск
 * после обрыва не начинает заново, а доделывает: заморозка уже стоит, история уже пересчитана,
 * чтение уже переключено — остаётся разморозка.
 */
export function planCutover(situation: CutoverSituation): CutoverPlan {
  const notes: string[] = [];
  const control = situation.controlRow;
  if (!control) {
    return {
      steps: [],
      blocking: [],
      refusal:
        'Управляющей строки модуля нет: `assignment_periods_control` пуста. Её заводит миграция ' +
        '0167 и удалению она не подлежит — без неё заморозка проходит вхолостую (И3).',
      notes,
    };
  }

  /*
   * Чтение уже на истории — вопрос закрыт, и второй раз его не задают. Но заморозка при этом может
   * стоять: ровно так выглядит окно, оборвавшееся между переключением и разморозкой, и портал в
   * этот момент молча не сохраняет заявки. Доделать её — единственная оставшаяся работа.
   */
  if (control.readMode === 'history') {
    if (control.writeMode === 'all_frozen' && !situation.keepFrozen) {
      return {
        steps: ['unfreeze'],
        blocking: [],
        refusal: null,
        notes: [
          'Чтение уже переключено на историю, а запись осталась замороженной: похоже на окно, ' +
            'оборвавшееся после переключения. Осталась разморозка.',
        ],
      };
    }
    return {
      steps: [],
      blocking: [],
      refusal: null,
      notes: ['Чтение уже идёт по истории назначения — переключать нечего.'],
    };
  }

  if (!situation.dataReady) {
    const count = situation.dataObstacles.length;
    return {
      steps: [],
      blocking: situation.dataObstacles,
      refusal:
        'Ярус данных не готов, и в окне это не чинится: ' +
        (count > 0
          ? `препятствий ${count}, каждое со своим путём — см. ниже`
          : 'сводка не назвала препятствий — разбирайте её выводом assignment-report --data'),
      notes,
    };
  }

  const attestation = situation.attestation;
  if (!attestation) {
    if (!situation.attestationRequired) {
      notes.push(
        'Аттестация не названа — шаги показаны без её проверки. Перед окном её снимает тот, кто ' +
          `раскатывал сборку: assignment-attest --build=${situation.buildSha} (О4).`,
      );
      return { steps: stepsOf(situation, notes), blocking: [], refusal: null, notes };
    }
    return {
      steps: [],
      blocking: [],
      refusal:
        'Аттестация раската не найдена. Её пишет тот, кто раскатывал сборку, своей ролью: ' +
        `assignment-attest --build=${situation.buildSha} (О4). Команда снимать её себе не вправе.`,
      notes,
    };
  }
  if (attestation.consumedAt) {
    return {
      steps: [],
      blocking: [],
      refusal:
        `Аттестация ${attestation.id} уже потреблена переходом: она годна ровно на одно ` +
        'переключение. Снимите свежую и повторите.',
      notes,
    };
  }
  if (attestation.algoVersion !== situation.algoVersion) {
    return {
      steps: [],
      blocking: [],
      refusal:
        `Аттестация снята алгоритмом ${attestation.algoVersion}, а переключаем алгоритмом ` +
        `${situation.algoVersion}: это разные сборки. Снимите аттестацию тем же кодом, что раскатан.`,
      notes,
    };
  }
  if (!attestation.activeBuildShas.includes(situation.buildSha)) {
    return {
      steps: [],
      blocking: [],
      refusal:
        `Сборка ${situation.buildSha} не названа в аттестации ` +
        `(там ${attestation.activeBuildShas.join(', ') || '—'}): ` +
        'переключение идёт не тем кодом, который аттестован.',
      notes,
    };
  }
  const remaining = attestationRemainingMs(attestation, situation.now);
  if (remaining < ATTESTATION_MIN_REMAINING_MS) {
    return {
      steps: [],
      blocking: [],
      refusal:
        `Аттестации осталось ${minutes(remaining)} — на окно этого не хватит: впереди ревалидация ` +
        'и полное теневое сравнение, а дверь принимает аттестацию не старше получаса. Снимите ' +
        'свежую прямо перед запуском.',
      notes,
    };
  }
  if (attestation.legacyClientCalls > 0) {
    return {
      steps: [],
      blocking: [],
      refusal:
        `Клиентский гейт не пройден: в аттестации ${attestation.legacyClientCalls} старых вызовов ` +
        'правки срока (И5). Дверь такую аттестацию не примет — сначала разберите, кто ходит ' +
        'мимо двери периода.',
      notes,
    };
  }
  notes.push(`Аттестация ${attestation.id} годна ещё ${minutes(remaining)}.`);
  return { steps: stepsOf(situation, notes), blocking: [], refusal: null, notes };
}

/**
 * Сами шаги — по тому, что уже сделано. Вынесено потому, что к этому месту приходят двумя путями:
 * с проверенной аттестацией (окно) и без неё (осмотр), а набор шагов у них один и тот же.
 */
function stepsOf(situation: CutoverSituation, notes: string[]): CutoverStep[] {
  const steps: CutoverStep[] = [];
  if (situation.controlRow?.writeMode === 'all_frozen') {
    notes.push('Запись уже заморожена целиком — шаг заморозки пропущен.');
  } else {
    steps.push('freeze');
  }
  steps.push('revalidate', 'shadow', 'verify', 'switch');
  if (situation.keepFrozen) {
    notes.push(
      'Разморозки не будет (--keep-frozen): портал останется закрытым для записи, пока её не ' +
        'снимут отдельной командой.',
    );
  } else {
    steps.push('unfreeze');
  }
  return steps;
}
