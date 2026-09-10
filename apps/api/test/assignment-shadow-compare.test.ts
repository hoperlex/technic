import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
// Только типы: значения берутся через `await import` уже после того, как выставлено окружение.
// Модуль сличения тянет за собой боевые расчёты бумаги, а те — прикладной конфиг, который
// проверяет переменные при импорте; без них файл падал бы на `config.ts`, ничего не сообщив о
// самом сличении. База при этом не поднимается и не спрашивается: ни одна проверка сюда не ходит.
import type * as Shadow from '../src/services/assignment-shadow';

/**
 * Сличение двух планов бумаги в теневом сравнении — участие **правки периода**
 * ([assignment-shadow.ts](../src/services/assignment-shadow.ts); планы
 * `docs/assignment-periods-plan.md` (этап 4, Г4, З4) и
 * `docs/vehicle-request-actual-end-date-plan.md` (Н7, Р5, Р6, этап Э4)).
 *
 * ПРЕДМЕТ. Не «правильно ли считают планировщики» — это вопрос к ним самим
 * ([esm2-plan.test.ts](esm2-plan.test.ts) и характеризующие тесты сверки), — а **видит ли сличение
 * разницу между их правками**. Вопрос отдельный, потому что у правки нет ни одного внешнего следа:
 * номер она не расходует, замены не выписывает, в графе замен не отражается. Разойдись стороны
 * правкой — `cancel` и `issue` у обеих останутся пустыми, поколение сравнения объявит цель
 * совпавшей, и переключение чтения (этап 5) пройдёт по зелёному прогону, после чего портал начнёт
 * двигать период действующего бланка не там, где обещал.
 *
 * ПОЧЕМУ ПАРОЙ ПЛАНОВ, А НЕ СЦЕНОЙ В БАЗЕ. Расхождение одних только правок на живых данных сегодня
 * недостижимо: чтобы два планировщика правили разные листы, им нужны разные ожидания, а разные
 * ожидания двигают заодно `cancel` и `issue` — и цель расходится уже по ним. Недостижимость эта —
 * свойство сегодняшних правил, а не гарантия: правило `trim` написано в двух планировщиках дважды
 * (Н7), и поправленное в одном оно разойдётся со вторым молча. Проверять поэтому нужно само
 * сличение, а сцена доказывала бы что угодно, кроме него. Согласие настоящих планировщиков на
 * настоящем закрытии проверяет соседний файл
 * ([assignment-shadow.db.test.ts](assignment-shadow.db.test.ts)).
 *
 * ЭСМ2-РАЗРЕЗ. Файл — часть инструмента, работающего только ДО переключения чтения: он сличает
 * недельный план с отрезковым. Обёртка двух режимов здесь бессмысленна — в `history` предмета не
 * существует вовсе (legacy-проекции больше нет), — поэтому запись реестра объявляет
 * `readModeIrrelevant`. Границы листов в сцене не декорация: ими меряются «дни бумаги», которыми
 * `week_split` отличается от `coverage`. Судьба всего контура решается на этапе 5 вместе с §10.
 */

// ── Сцена: две недели августа 2026 и два действующих листа ──

const MONDAY = '2026-08-03';
const WEDNESDAY = '2026-08-05';
const THURSDAY = '2026-08-06';
const SUNDAY = '2026-08-09';
const NEXT_MONDAY = '2026-08-10';
const NEXT_SUNDAY = '2026-08-16';

/**
 * Действующие листы, прочитанные обеими сторонами из одного снимка.
 *
 * Идентификаторы читаемые вместо uuid: «правят W1 против W2» в отчёте о падении понятнее любого
 * ключа. Границы настоящие — по ним считается мера «дни бумаги» внутри классификации.
 */
const SHEETS = [
  { id: 'W1', periodFrom: MONDAY, periodTo: SUNDAY },
  { id: 'W2', periodFrom: NEXT_MONDAY, periodTo: NEXT_SUNDAY },
];

/** Документ к выписке: состав у сцены один — машина `A`, машинист `P`. */
const issued = (from: string, to: string) => ({
  from,
  to,
  vehicleId: 'A',
  driverPersonId: 'P',
});

let shadow: typeof Shadow;

beforeAll(async () => {
  process.env.NODE_ENV ??= 'test';
  process.env.DATABASE_URL ??= 'postgres://unused:unused@localhost:5432/unused';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.JWT_PRIVATE_KEY_PEM ??= String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM ??= String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  shadow = await import('../src/services/assignment-shadow');
});

/** План стороны — той же нормализацией, какой его строит боевой расчёт. */
function plan(parts: {
  cancel?: string[];
  issue?: { from: string; to: string; vehicleId: string; driverPersonId: string | null }[];
  trim?: { waybillId: string; to: string }[];
}): Shadow.ShadowComparablePlan {
  return shadow.toShadowComparable(parts.cancel ?? [], parts.issue ?? [], parts.trim ?? []);
}

/** Сличение без отрезкового плана: `wanted` нужен только пробелу машиниста, а его в сцене нет. */
const verdict = (legacy: Shadow.ShadowComparablePlan, fresh: Shadow.ShadowComparablePlan) =>
  shadow.compareShadowPlans(legacy, fresh, null, SHEETS);

describe('теневое сравнение: правка периода участвует в сличении', () => {
  it('обе стороны правят один лист до одного дня — расхождения нет', () => {
    // Закрытие заказа фактической датой: неделя пн–вс сокращается до среды, номер не расходуется.
    const legacy = plan({ trim: [{ waybillId: 'W1', to: WEDNESDAY }] });
    const fresh = plan({ trim: [{ waybillId: 'W1', to: WEDNESDAY }] });
    expect(verdict(legacy, fresh)).toEqual({ status: 'match' });
  });

  it('стороны правят разные листы — расхождение видно и названо правкой', () => {
    // Худший из невидимых случаев: у обеих сторон `cancel` и `issue` пусты, и до Э4 цель
    // считалась совпавшей — при том что двигают они период разных бланков.
    const legacy = plan({ trim: [{ waybillId: 'W1', to: WEDNESDAY }] });
    const fresh = plan({ trim: [{ waybillId: 'W2', to: WEDNESDAY }] });
    expect(verdict(legacy, fresh)).toEqual({ status: 'mismatch', reason: 'trim' });
  });

  it('стороны правят один лист до разных дней — расхождение видно и названо правкой', () => {
    const legacy = plan({ trim: [{ waybillId: 'W1', to: WEDNESDAY }] });
    const fresh = plan({ trim: [{ waybillId: 'W1', to: THURSDAY }] });
    expect(verdict(legacy, fresh)).toEqual({ status: 'mismatch', reason: 'trim' });
  });

  it('порядок правок расхождением не является', () => {
    // У недельной стороны правки идут неделями срока, у отрезковой — отрезками разреза: набор
    // один, порядок разный, и сравнение сырых списков объявило бы расхождение на ровном месте.
    const legacy = plan({
      trim: [
        { waybillId: 'W1', to: WEDNESDAY },
        { waybillId: 'W2', to: THURSDAY },
      ],
    });
    const fresh = plan({
      trim: [
        { waybillId: 'W2', to: THURSDAY },
        { waybillId: 'W1', to: WEDNESDAY },
      ],
    });
    expect(verdict(legacy, fresh)).toEqual({ status: 'match' });
  });

  it('правка против пары «аннулирование плюс выписка» видна и без сличения правок', () => {
    /*
     * Э3 обещал, что этот случай сличение ловило и до Э4: у стороны, которая перевыписывает,
     * появляются `cancel` и `issue`, которых у правящей нет. Проверяется тут не столько сам факт,
     * сколько **имя** расхождения: правкой оно не называется — расходятся документы, и чинить
     * придётся их. Дни при этом у сторон одни и те же (`W1` кончается средой у обеих), поэтому
     * мера «дни бумаги» обязана считать правленый лист сокращённым — иначе разрез объявили бы
     * «разными днями».
     */
    const legacy = plan({ trim: [{ waybillId: 'W1', to: WEDNESDAY }] });
    const fresh = plan({ cancel: ['W1'], issue: [issued(MONDAY, WEDNESDAY)] });
    expect(verdict(legacy, fresh)).toEqual({ status: 'mismatch', reason: 'week_split' });
  });

  it('совпавшие правки не заслоняют расхождения в гашении', () => {
    // Причина у цели одна, и называть она обязана большее из расхождений: правки сошлись,
    // разошёлся расход номеров.
    const legacy = plan({ cancel: ['W2'], trim: [{ waybillId: 'W1', to: WEDNESDAY }] });
    const fresh = plan({ trim: [{ waybillId: 'W1', to: WEDNESDAY }] });
    expect(verdict(legacy, fresh)).toEqual({ status: 'mismatch', reason: 'cancel' });
  });

  it('планы без правок сличаются как прежде', () => {
    // Страховка от обратного: поле, добавленное в ключ, не должно ссорить стороны, у которых
    // правок нет вовсе.
    const legacy = plan({ cancel: ['W1'], issue: [issued(MONDAY, WEDNESDAY)] });
    const fresh = plan({ cancel: ['W1'], issue: [issued(MONDAY, WEDNESDAY)] });
    expect(verdict(legacy, fresh)).toEqual({ status: 'match' });
    expect(verdict(legacy, plan({ cancel: ['W1'] }))).toEqual({
      status: 'mismatch',
      reason: 'coverage',
    });
  });
});
