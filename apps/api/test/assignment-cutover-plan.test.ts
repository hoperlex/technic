import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_MIN_REMAINING_MS,
  planCutover,
  type CutoverAttestation,
  type CutoverSituation,
} from '../scripts/assignment-cutover-plan';
import type { CutoverObstacle } from '../src/services/assignment-readiness';

/**
 * Порядок окна переключения чтения — как решение, а не как последовательность вызовов
 * (`docs/assignment-periods-plan.md` §10; команда — `scripts/assignment-cutover.ts`).
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ЭТО. Шаги окна нельзя переставить, и цена перестановки —
 * само окно: портал в нём закрыт для записи, аттестация живёт полчаса, поколение не переживает
 * полуночи. Пока порядок исполняли руками по runbook, проверить его было нечем — а проверять надо
 * не «вызвалось ли», а четыре вещи:
 *
 * 1. **не начинаем там, где начинать нельзя.** Отказ обязан приходить ДО заморозки: неготовые
 *    данные, чужая или протухшая аттестация, ненулевой клиентский гейт. Отказ после заморозки —
 *    это закрытый портал и разбор в окне;
 * 2. **сделанное не делается заново.** Заморозка уже стоит — шаг пропускается; чтение уже
 *    переключено — окна нет вовсе. Это и есть возобновляемость: повтор после обрыва доделывает;
 * 3. **оборвавшееся после переключения окно закрывается разморозкой.** Самый дорогой из исходов:
 *    портал в нём молча не сохраняет заявки, и заметить это можно только по метрике;
 * 4. **запас годности аттестации спрашивается заранее.** Между её снятием и переключением лежат
 *    ревалидация и полное сравнение — минуты, а не секунды.
 *
 * ПОЧЕМУ БЕЗ БАЗЫ. Предмет файла — сам порядок, и он чистая функция от состояния. Проверки двери
 * (матрица переходов, готовность популяции, потребление аттестации) живут в сервисе и считаются
 * под блокировкой — их проверяют `assignment-mode.db.test.ts` и `assignment-report.db.test.ts`.
 */

const NOW = new Date('2026-09-17T08:00:00Z');
const BUILD = 'a1b2c3d';

function attestation(overrides: Partial<CutoverAttestation> = {}): CutoverAttestation {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    attestedAt: new Date(NOW.getTime() - 60_000),
    consumedAt: null,
    activeBuildShas: [BUILD],
    algoVersion: '1',
    legacyClientCalls: 0,
    ...overrides,
  };
}

function obstacle(overrides: Partial<CutoverObstacle> = {}): CutoverObstacle {
  return {
    kind: 'history_materialized',
    tier: 'data',
    count: 12,
    what: 'заявки с историей, но без валидности',
    fix: 'дверь ремонта',
    samples: ['ТС-101'],
    ...overrides,
  };
}

function situation(overrides: Partial<CutoverSituation> = {}): CutoverSituation {
  return {
    controlRow: { writeMode: 'normal', readMode: 'legacy' },
    dataReady: true,
    dataObstacles: [],
    attestation: attestation(),
    attestationRequired: true,
    algoVersion: '1',
    buildSha: BUILD,
    now: NOW,
    keepFrozen: false,
    ...overrides,
  };
}

describe('порядок окна переключения', () => {
  it('на готовом контуре раскладывается в шесть шагов, и заморозка идёт первой', () => {
    const plan = planCutover(situation());
    expect(plan.refusal).toBeNull();
    expect(plan.steps).toEqual(['freeze', 'revalidate', 'shadow', 'verify', 'switch', 'unfreeze']);
  });

  it('уже стоящую заморозку не ставит второй раз', () => {
    const plan = planCutover(
      situation({ controlRow: { writeMode: 'all_frozen', readMode: 'legacy' } }),
    );
    expect(plan.steps).toEqual(['revalidate', 'shadow', 'verify', 'switch', 'unfreeze']);
    expect(plan.notes.join(' ')).toContain('уже заморожена');
  });

  it('заморозку отката (history_frozen) ужесточает до полной', () => {
    const plan = planCutover(
      situation({ controlRow: { writeMode: 'history_frozen', readMode: 'legacy' } }),
    );
    expect(plan.steps[0]).toBe('freeze');
  });

  it('с --keep-frozen не размораживает: разморозка становится отдельным шагом человека', () => {
    const plan = planCutover(situation({ keepFrozen: true }));
    expect(plan.steps).not.toContain('unfreeze');
    expect(plan.notes.join(' ')).toContain('--keep-frozen');
  });
});

describe('окно, оборвавшееся на середине', () => {
  it('после переключения закрывается одной разморозкой', () => {
    const plan = planCutover(
      situation({ controlRow: { writeMode: 'all_frozen', readMode: 'history' } }),
    );
    expect(plan.refusal).toBeNull();
    expect(plan.steps).toEqual(['unfreeze']);
  });

  it('на переключённом и размороженном контуре не делает ничего', () => {
    const plan = planCutover(
      situation({ controlRow: { writeMode: 'normal', readMode: 'history' } }),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.refusal).toBeNull();
    expect(plan.notes.join(' ')).toContain('уже идёт по истории');
  });

  it('переключённое чтение с --keep-frozen не размораживает вопреки просьбе', () => {
    const plan = planCutover(
      situation({ controlRow: { writeMode: 'all_frozen', readMode: 'history' }, keepFrozen: true }),
    );
    expect(plan.steps).toEqual([]);
  });
});

describe('отказы до заморозки', () => {
  it('без управляющей строки — отказ, а не «пусто»', () => {
    const plan = planCutover(situation({ controlRow: null }));
    expect(plan.steps).toEqual([]);
    expect(plan.refusal).toContain('Управляющей строки');
  });

  it('неготовые данные отдаются препятствиями со своим путём, а не общим советом', () => {
    const repair = obstacle({ count: 324 });
    const shadow = obstacle({
      kind: 'shadow_mismatch',
      count: 7,
      what: 'поколение зафиксировало расхождения планов бумаги',
      fix: 'assignment-shadow mismatches --run=…',
      samples: [],
    });
    const plan = planCutover(situation({ dataReady: false, dataObstacles: [repair, shadow] }));
    expect(plan.steps).toEqual([]);
    expect(plan.blocking).toEqual([repair, shadow]);
    // Совет у отказа свой не появляется: у бэкфилла и у разбора расхождений пути разные, и один
    // общий отправил бы половину случаев не туда.
    expect(plan.refusal).not.toContain('assignment-backfill');
  });

  it('без аттестации окно не начинается и отсылает к тому, кто раскатывал', () => {
    const plan = planCutover(situation({ attestation: null }));
    expect(plan.steps).toEqual([]);
    expect(plan.refusal).toContain('assignment-attest');
  });

  it('осмотру аттестация не нужна: он показывает шаги, а не открывает дверь', () => {
    // `status` спрашивают до окна, когда аттестации законно ещё нет: её снимают перед самым
    // переключением. Отказ здесь называл бы отказом сам порядок работ.
    const plan = planCutover(situation({ attestation: null, attestationRequired: false }));
    expect(plan.refusal).toBeNull();
    expect(plan.steps).toContain('switch');
    expect(plan.notes.join(' ')).toContain('assignment-attest');
  });

  it('потреблённая аттестация отвергается: она годна на одно переключение', () => {
    const plan = planCutover(
      situation({ attestation: attestation({ consumedAt: new Date(NOW.getTime() - 1000) }) }),
    );
    expect(plan.refusal).toContain('потреблена');
  });

  it('аттестация чужой сборки отвергается', () => {
    const plan = planCutover(
      situation({ attestation: attestation({ activeBuildShas: ['deadbee'] }) }),
    );
    expect(plan.refusal).toContain('не названа в аттестации');
  });

  it('аттестация чужого алгоритма отвергается', () => {
    const plan = planCutover(situation({ attestation: attestation({ algoVersion: '2' }) }));
    expect(plan.refusal).toContain('алгоритм');
  });

  it('аттестации без запаса на работу окна не хватает', () => {
    const almostStale = attestation({
      attestedAt: new Date(NOW.getTime() - (30 * 60 * 1000 - ATTESTATION_MIN_REMAINING_MS + 1000)),
    });
    const plan = planCutover(situation({ attestation: almostStale }));
    expect(plan.refusal).toContain('Снимите');
    expect(plan.steps).toEqual([]);
  });

  it('ненулевой клиентский гейт отвергается до заморозки, а не отказом двери', () => {
    const plan = planCutover(situation({ attestation: attestation({ legacyClientCalls: 7 }) }));
    expect(plan.refusal).toContain('7');
    expect(plan.refusal).toContain('гейт');
  });
});
