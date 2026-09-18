import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  deviceIdentityHintsSchema,
  type DeviceMailContext,
  type DeviceObservationInput,
} from '@technic/contracts';
import { parseDeviceMail } from '../src/services/device-mail/mime';
import {
  DeviceRuleError,
  applyIdentityRules,
  applyMetricRules,
  assertSafeExpression,
  findByRule,
  ruleApplies,
  type ParseRuleRow,
  type ParseRuleSet,
} from '../src/services/device-mail/rules';

/**
 * ПРАВИЛА РАЗБОРА (план `docs/office-equipment-mail-identity-ui-plan.md`, §5.2).
 *
 * БЕЗ БАЗЫ, на живых фикстурах `.eml`: предмет проверки — что именно правило достаёт из письма и
 * чем оно перебивает профиль. Ни одно из этих утверждений не про SQL.
 *
 * Что доказывается:
 *
 * - **правило-метка находит значение** там же, где его нашёл бы профиль, и пользуется ТЕМ ЖЕ
 *   разбором меток: свой поиск разошёлся бы с профильным на первой же цепочке точек;
 * - **правило перекрывает профиль**, а не дополняет его: под формат пишут правило, а словарь
 *   профиля общий;
 * - **первое правило рода выигрывает**: порядок задаёт человек, и спорить с ним портал не вправе;
 * - **условия применимости** (профиль, отправитель, тема) отсекают чужие письма;
 * - **область поиска сужает письмо**: правило по теме не видит тела, и наоборот;
 * - **единица берётся из реестра метрик**, а не из правила: второй носитель разошёлся бы с
 *   реестром на первой правке;
 * - **опасное выражение отклоняется словами** — обратная ссылка и повтор на повторяющейся группе
 *   вешают разбор всей очереди, а не одного письма.
 */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/device-mail/synthetic/', import.meta.url));

async function contextOf(name: string): Promise<DeviceMailContext> {
  return parseDeviceMail(readFileSync(`${FIXTURE_DIR}${name}`), {
    envelopeTo: 'devices@portal.example.test',
  });
}

function identityRule(over: Partial<ParseRuleRow> = {}): ParseRuleRow {
  return {
    id: over.id ?? 'r1',
    target: 'identity',
    keyKind: 'serial',
    metricCode: null,
    component: null,
    valueForm: null,
    matchKind: 'label',
    expression: 'serial number',
    scope: 'any',
    whenProfile: null,
    whenFrom: '',
    whenSubject: '',
    ...over,
  };
}

function metricRule(over: Partial<ParseRuleRow> = {}): ParseRuleRow {
  return {
    id: over.id ?? 'm1',
    target: 'metric',
    keyKind: null,
    metricCode: 'printed_sheets_total',
    component: '',
    valueForm: 'number',
    matchKind: 'label',
    expression: 'printed sheets',
    scope: 'any',
    whenProfile: null,
    whenFrom: '',
    whenSubject: '',
    ...over,
  };
}

const setOf = (...rules: ParseRuleRow[]): ParseRuleSet => ({ rules, revision: new Date() });

const EMPTY_HINTS = deviceIdentityHintsSchema.parse({});

describe('правила разбора: ключи опознания', () => {
  it('правило-метка достаёт значение из письма', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    expect(findByRule(identityRule(), ctx)).toBe('SYN0001AA');
  });

  it('правило перекрывает подсказку профиля', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    const hints = deviceIdentityHintsSchema.parse({ serial: 'ИЗ-ПРОФИЛЯ' });
    const out = applyIdentityRules(hints, ctx, setOf(identityRule()), 'unknown');
    expect(out.serial).toBe('SYN0001AA');
    // Остальные подсказки профиля правило не трогает: оно отвечает за свой род и только за него.
    expect(out.inventory).toBe(hints.inventory);
  });

  it('первое правило рода выигрывает, остальные того же рода не спрашиваются', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    const out = applyIdentityRules(
      EMPTY_HINTS,
      ctx,
      setOf(
        identityRule({ id: 'первое', expression: 'device name', keyKind: 'serial' }),
        identityRule({ id: 'второе', expression: 'serial number', keyKind: 'serial' }),
      ),
      'unknown',
    );
    expect(out.serial).toBe('SYN-MFP-01');
  });

  it('условие по отправителю отсекает чужое письмо', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    expect(ruleApplies(identityRule({ whenFrom: 'printer-01@' }), ctx, 'unknown')).toBe(true);
    expect(ruleApplies(identityRule({ whenFrom: 'kyocera@' }), ctx, 'unknown')).toBe(false);
  });

  it('условие по профилю отсекает письмо другого вендора', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    expect(ruleApplies(identityRule({ whenProfile: 'ricoh' }), ctx, 'ricoh')).toBe(true);
    expect(ruleApplies(identityRule({ whenProfile: 'ricoh' }), ctx, 'kyocera')).toBe(false);
  });

  it('область поиска сужает письмо: в теме тела не видно', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    // Метка «serial number» стоит в теле, а не в теме: сужение обязано её потерять.
    expect(findByRule(identityRule({ scope: 'subject' }), ctx)).toBeNull();
    expect(findByRule(identityRule({ scope: 'text' }), ctx)).toBe('SYN0001AA');
  });

  it('выражение достаёт значение из темы письма', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    const rule = identityRule({
      matchKind: 'regex',
      scope: 'subject',
      expression: 'Counter report (?<value>[A-Z0-9]+)',
    });
    expect(findByRule(rule, ctx)).toBe('SYN0001AA');
  });

  it('правило, которое ничего не нашло, оставляет подсказку профиля нетронутой', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    const hints = deviceIdentityHintsSchema.parse({ serial: 'ИЗ-ПРОФИЛЯ' });
    const out = applyIdentityRules(
      hints,
      ctx,
      setOf(identityRule({ expression: 'такой метки в письме нет' })),
      'unknown',
    );
    expect(out.serial).toBe('ИЗ-ПРОФИЛЯ');
  });
});

describe('правила разбора: показания', () => {
  it('правило добавляет наблюдение, а единицу берёт из реестра метрик', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    const out = applyMetricRules([], ctx, setOf(metricRule()), 'unknown');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      metricCode: 'printed_sheets_total',
      component: '',
      value: '987654',
      // Единица не из правила: у правила её нет ни одной колонкой.
      unit: 'sheets',
      rawLabel: 'printed sheets',
    });
  });

  it('правило перекрывает наблюдение профиля с той же парой «метрика и разрез»', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    const fromProfile: DeviceObservationInput[] = [
      {
        metricCode: 'printed_sheets_total',
        component: '',
        value: '1',
        unit: 'sheets',
        deviceTime: null,
        rawLabel: 'из профиля',
      },
    ];
    const out = applyMetricRules(fromProfile, ctx, setOf(metricRule()), 'unknown');
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe('987654');
  });

  it('проценты читаются формой правила, а не угадыванием', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    const out = applyMetricRules(
      [],
      ctx,
      setOf(
        metricRule({
          metricCode: 'supply_level_percent',
          component: 'black',
          valueForm: 'percent',
          expression: 'toner black',
        }),
      ),
      'unknown',
    );
    expect(out[0]).toMatchObject({ value: '45', unit: 'percent', component: 'black' });
  });

  it('значение, которое числом не читается, наблюдением не становится', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    // «Status: Ready» — метка есть, числа нет. Ноль здесь был бы враньём в ряду наработки.
    const out = applyMetricRules([], ctx, setOf(metricRule({ expression: 'status' })), 'unknown');
    expect(out).toHaveLength(0);
  });
});

describe('правила разбора: враждебное выражение', () => {
  it('обратная ссылка отклоняется словами', () => {
    expect(() => assertSafeExpression('(a)\\1+')).toThrow(DeviceRuleError);
  });

  it('повтор на повторяющейся группе отклоняется словами', () => {
    expect(() => assertSafeExpression('(a+)+$')).toThrow(DeviceRuleError);
  });

  it('обычное выражение проходит', () => {
    expect(() => assertSafeExpression('Serial:\\s*(?<value>[A-Z0-9-]{4,20})')).not.toThrow();
  });

  it('нечитаемое выражение отклоняется словами, а не падает наружу', async () => {
    const ctx = await contextOf('01-plain-counters.eml');
    expect(() => findByRule(identityRule({ matchKind: 'regex', expression: '([' }), ctx)).toThrow(
      DeviceRuleError,
    );
  });
});
