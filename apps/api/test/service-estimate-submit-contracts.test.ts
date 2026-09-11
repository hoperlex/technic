import { describe, expect, it } from 'vitest';
import {
  allowsEstimateApprovalInStatus,
  canDeclareExemption,
  evaluateExemption,
  submitServiceEstimateSchema,
  type AccessSubject,
  type ServiceExecutorAssignment,
} from '@technic/contracts';

/**
 * Тело предъявления объёма работ и два предиката освобождения (план
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р2, Р3, Р9).
 *
 * ЗАЧЕМ СВОЙ ФАЙЛ. До этой волны тело предъявления было плоским — `{ warrantyRepair, comment,
 * version }`, — и его совместимость держали два db-теста, которые продолжают слать старую форму
 * СЛУЧАЙНО: они писались не про неё. Форматов стало три, и у совместимости появилась цена: старый
 * портал выкатывается ПОЗЖЕ сервера, и сервер, перестав понимать прежнее тело, вернул бы 400 на
 * каждую кнопку «Предъявить» в окне выката. Такую поломку не видно ни типом, ни глазами — видно
 * только тестом, который шлёт именно старую форму и ждёт, что из неё получится.
 *
 * Второе, что здесь доказывается, — ДВЕРЬ К ДЕНЬГАМ. Освобождение от подписи доступно одному
 * субъекту (оператору назначенного контрагента-сервиса), а подпись в «Решена» — только ожиданию,
 * рождённому разрешённым спором. Оба правила односложны в коде и потому особенно легко «упрощаются»
 * следующей правкой: проверка строкой превращает их в перечень случаев, который уже нельзя сузить
 * молча.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';

/** Оператор сервисной компании: роль, привязанная к контрагенту, и тип контрагента «сервис». */
const SERVICE_OPERATOR: AccessSubject = {
  role: 'operator',
  counterpartyType: 'service',
  grantPermissions: ['serviceRequests.estimate'],
};

/** Свой сотрудник с тем же правом: права хватает, стороны — нет (Р3, ответ В1). */
const STAFF: AccessSubject = {
  role: 'shtab',
  grantPermissions: ['serviceRequests.estimate', 'serviceRequests.execute'],
};

/** Назначение оператора на ЭТУ заявку: второй сомножитель права заявить освобождение. */
const ASSIGNED: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: true,
  isNamedExecutor: false,
};
const NOT_ASSIGNED: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: false,
  isNamedExecutor: false,
};

/** Заявка внешнего ремонта в работе, предъявления не висит — состояние, в котором всё и происходит. */
const IN_WORK = {
  kind: 'repair',
  status: 'in_work',
  serviceCounterpartyId: UUID,
  estimatePendingRevision: null,
} as const;

describe('тело предъявления объёма работ', () => {
  /**
   * Старое плоское тело — ровно то, что шлёт вкладка предыдущего выпуска. Проверяются все четыре
   * формы, потому что различаются они последствиями: `true` означает гарантийный ремонт со
   * служебной нулевой строкой, а `false` и отсутствие признака — обычное построчное предъявление.
   * Перепутай нормализация эти две дороги — подрядчику списали бы работу в ноль либо, наоборот,
   * выставили счёт по гарантии.
   */
  it('старое тело без mode нормализуется в формат: warrantyRepair решает, в какой', () => {
    const parsed = (body: unknown) => submitServiceEstimateSchema.parse(body);
    expect(parsed({ warrantyRepair: true, comment: '', version: 3 })).toMatchObject({
      mode: 'warranty',
      version: 3,
    });
    expect(parsed({ warrantyRepair: false, comment: '', version: 3 })).toMatchObject({
      mode: 'items',
    });
    expect(parsed({ comment: 'без признака вовсе', version: 3 })).toMatchObject({ mode: 'items' });
    expect(parsed({ version: 3 })).toMatchObject({ mode: 'items' });
  });

  /**
   * Тело, задающее формат ДВАЖДЫ, отбивается, а не разрешается старшинством. Старый клиент под это
   * правило не попадает никогда (он про `mode` не знает), а новый, приславший оба поля, сам не
   * знает, чего хочет, — и молчаливый выбор за него развёл бы гарантийное предъявление с подписью.
   */
  it('mode вместе с warrantyRepair и небулево значение признака — отказ', () => {
    expect(() =>
      submitServiceEstimateSchema.parse({ mode: 'items', warrantyRepair: true, version: 1 }),
    ).toThrow();
    expect(() => submitServiceEstimateSchema.parse({ warrantyRepair: 'да', version: 1 })).toThrow();
  });

  /**
   * Незаконные сочетания не собираются ТИПОМ (Р2): у гарантийного ремонта нулевая сумма, и
   * освобождать от подписи там нечего, а документный формат без документа — не формат, а пустая
   * ревизия. Проверка схемой, а не ручкой, — это и есть «нельзя собрать»: отказ приходит раньше,
   * чем кто-нибудь успеет прочитать половину тела.
   */
  it('warranty с освобождением и document без файлов не собираются', () => {
    expect(() =>
      submitServiceEstimateSchema.parse({ mode: 'warranty', exemption: {}, version: 1 }),
    ).toThrow();
    expect(() =>
      submitServiceEstimateSchema.parse({ mode: 'document', fileIds: [], version: 1 }),
    ).toThrow();
    // А законные — собираются, и освобождение разрешено обоим содержательным форматам.
    expect(
      submitServiceEstimateSchema.parse({ mode: 'document', fileIds: [FILE], version: 1 }),
    ).toMatchObject({ mode: 'document' });
    expect(
      submitServiceEstimateSchema.parse({
        mode: 'items',
        exemption: { note: 'на месте' },
        version: 1,
      }),
    ).toMatchObject({ mode: 'items', exemption: { note: 'на месте' } });
  });
});

describe('кому дано заявить освобождение и что из него выходит', () => {
  /**
   * Сторона — единственный ответ заказчика на вопрос «кому доверено» (В1, 11.09.2026): чекбокс
   * просил представитель сервиса, он же им и пользуется. Право `serviceRequests.estimate` само по
   * себе двери не открывает — иначе освобождение получил бы любой свой сотрудник, который объём
   * работ и так не составляет.
   */
  it('только оператор НАЗНАЧЕННОГО контрагента-сервиса', () => {
    expect(canDeclareExemption(IN_WORK, SERVICE_OPERATOR, ASSIGNED)).toBe(true);
    // Тот же оператор, но заявка назначена не ему.
    expect(canDeclareExemption(IN_WORK, SERVICE_OPERATOR, NOT_ASSIGNED)).toBe(false);
    // Свой сотрудник с правом на объём работ — не та сторона.
    expect(canDeclareExemption(IN_WORK, STAFF, ASSIGNED)).toBe(false);
    expect(canDeclareExemption(IN_WORK, null, ASSIGNED)).toBe(false);
  });

  /**
   * Три прочих условия — те же, что у предъявления: внутренний ремонт объёма работ не составляет
   * вовсе, из другого статуса не предъявляют, а под висящим предъявлением подменять подпись нельзя
   * (иначе согласующий смотрел бы на цифры, которых уже нет).
   */
  it('внутренний ремонт, другой статус и висящее предъявление закрывают дверь', () => {
    expect(
      canDeclareExemption({ ...IN_WORK, serviceCounterpartyId: null }, SERVICE_OPERATOR, ASSIGNED),
    ).toBe(false);
    expect(canDeclareExemption({ ...IN_WORK, status: 'done' }, SERVICE_OPERATOR, ASSIGNED)).toBe(
      false,
    );
    expect(
      canDeclareExemption({ ...IN_WORK, estimatePendingRevision: 2 }, SERVICE_OPERATOR, ASSIGNED),
    ).toBe(false);
  });

  /**
   * Исходов ровно два, и рубильник гасит ИСХОД, а не команду: при выключенном ключе заявление
   * записывается, но подпись собирается обычным путём (режим наблюдения, §7 плана). Третьего исхода
   * нет, потому что нет ни лимита, ни политики — ответы В2 и В12.
   */
  it('исход заявления решает рубильник, и исходов два', () => {
    expect(evaluateExemption({ flagEnabled: true })).toBe('applied');
    expect(evaluateExemption({ flagEnabled: false })).toBe('observed');
  });
});

describe('в каком статусе согласуют объём работ', () => {
  /**
   * «В работе» — как было всегда. «Решена» открывается ТОЛЬКО постспорному ожиданию текущей
   * ревизии: спор по заявке с предъявленным фактом разрешают подписью, а возврат в «В работе» стёр
   * бы факт, суммы и гарантии (находка Н12). Любое другое ожидание, случайно оказавшееся в
   * «Решена», дверь не открывает — иначе предикат пустил бы к подписи наследственную заявку.
   */
  it('«Решена» пускает только ожидание, рождённое спором по этой же ревизии', () => {
    expect(allowsEstimateApprovalInStatus({ status: 'in_work' })).toBe(true);
    expect(
      allowsEstimateApprovalInStatus({
        status: 'done',
        estimatePendingSource: 'dispute',
        estimatePendingRevision: 4,
        estimateRevision: 4,
      }),
    ).toBe(true);
    // Ожидание от обычного предъявления в «Решена» не подписывают.
    expect(
      allowsEstimateApprovalInStatus({
        status: 'done',
        estimatePendingSource: 'submit',
        estimatePendingRevision: 4,
        estimateRevision: 4,
      }),
    ).toBe(false);
    // Ревизии разошлись: подписывать нечего — содержимое уже переиздали.
    expect(
      allowsEstimateApprovalInStatus({
        status: 'done',
        estimatePendingSource: 'dispute',
        estimatePendingRevision: 3,
        estimateRevision: 4,
      }),
    ).toBe(false);
    // Пустые поля — отказ (fail-closed): в окне выката сервер их ещё не отдаёт.
    expect(allowsEstimateApprovalInStatus({ status: 'done' })).toBe(false);
    expect(allowsEstimateApprovalInStatus({ status: 'accepted' })).toBe(false);
  });
});
