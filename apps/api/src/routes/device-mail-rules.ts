import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  deviceParseRuleInputSchema,
  deviceParseRulePreviewSchema,
  metricUnitLabels,
  metricUnits,
  normalizeIdentityValue,
  officeEquipmentTitle,
  type ComponentCode,
  type DeviceParseRuleDto,
  type DeviceParseRulePreviewDto,
  type MetricCode,
  type ParseRuleMatchKind,
  type ParseRuleScope,
  type ParseRuleTarget,
  type ParseValueForm,
  type DeviceProfileCode,
} from '@technic/contracts';
import { db } from '../db/client';
import { deviceMailMessages, deviceMailParseRules, officeEquipment, users } from '../db/schema';
import { requirePrincipal } from '../auth/plugin';
import { err } from '../lib/errors';
import { parseDeviceMail } from '../services/device-mail/mime';
import { getDeviceMailRaw } from '../services/device-mail/storage';
import { chooseProfile } from '../services/device-mail/profiles';
import { resolveDeviceIdentity } from '../services/device-mail/identity';
import {
  DeviceRuleError,
  assertSafeExpression,
  findByRule,
  ruleApplies,
  ruleNumber,
  type ParseRuleRow,
} from '../services/device-mail/rules';

/**
 * ПРАВИЛА РАЗБОРА — третья дверь к резолву (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §6.2).
 *
 * ЗАЧЕМ ЭТИ РУЧКИ. Метки, по которым из письма достают серийник и счётчик, до сих пор жили только
 * в коде: аппарат, подписавший поле иначе, требовал правки и выката. Здесь формат закрывается
 * правилом — и закрывается тем, кто разбирает письма, а не тем, кто катит релизы.
 *
 * ПРОВЕРКА НА ЖИВОМ ПИСЬМЕ — НЕ УДОБСТВО, А УСЛОВИЕ. Правило метрики кладёт число в ряд наработки,
 * и ошибку в нём заметить некому: счётчик МФУ никто не помнит наизусть. Поэтому рядом с формой
 * стоит `preview`, который ничего не пишет и показывает, что получилось бы.
 *
 * ПРАВО ОДНО — `officeEquipment.telemetry` (решение заказчика 18.09.2026): правила настраивает тот
 * же круг, что разбирает очередь.
 */

const idParams = z.object({ id: z.string().uuid() });

interface RuleRecord {
  id: string;
  target: string;
  keyKind: string | null;
  metricCode: string | null;
  component: string | null;
  valueForm: string | null;
  matchKind: string;
  expression: string;
  scope: string;
  whenProfile: string | null;
  whenFrom: string;
  whenSubject: string;
  sortOrder: number;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  updatedByName: string | null;
}

/**
 * Правило можно удалить совсем, только если при его жизни не разобрали ни одного письма (Р4):
 * иначе оно объясняет, почему письма прочитаны именно так, и остаётся выключенным.
 *
 * Считается по отметке набора в строке письма, а не по «ссылке на правило» — такой ссылки нет и
 * быть не может: снимок разбора хранит результат, а не путь к нему.
 */
async function deletableIds(rules: RuleRecord[]): Promise<Set<string>> {
  const deletable = new Set<string>();
  if (rules.length === 0) return deletable;
  const oldest = rules.reduce(
    (min, rule) => (rule.createdAt < min ? rule.createdAt : min),
    rules[0]!.createdAt,
  );
  const rows = await db
    .select({ revision: sql<string | null>`min(${deviceMailMessages.rulesRevision})` })
    .from(deviceMailMessages)
    .where(
      and(
        isNotNull(deviceMailMessages.rulesRevision),
        lte(sql`${oldest}`, deviceMailMessages.rulesRevision),
      ),
    );
  const earliest = rows[0]?.revision ? new Date(rows[0].revision) : null;
  for (const rule of rules) {
    // Писем, разобранных после появления правила, нет вовсе — удалять безопасно.
    if (!earliest || earliest < rule.createdAt) deletable.add(rule.id);
  }
  return deletable;
}

function toDto(row: RuleRecord, canDelete: boolean): DeviceParseRuleDto {
  return {
    id: row.id,
    target: row.target as ParseRuleTarget,
    keyKind: (row.keyKind as DeviceParseRuleDto['keyKind']) ?? null,
    metricCode: (row.metricCode as MetricCode | null) ?? null,
    component: (row.component as ComponentCode | null) ?? null,
    valueForm: (row.valueForm as ParseValueForm | null) ?? null,
    matchKind: row.matchKind as ParseRuleMatchKind,
    expression: row.expression,
    scope: row.scope as ParseRuleScope,
    whenProfile: (row.whenProfile as DeviceProfileCode | null) ?? null,
    whenFrom: row.whenFrom,
    whenSubject: row.whenSubject,
    sortOrder: row.sortOrder,
    isEnabled: row.isEnabled,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: row.updatedByName ?? '',
    canDelete,
  };
}

/** Значения правила в колонки: у ключа пусты метрика и разрез, у показания — род ключа. */
function toColumns(input: z.infer<typeof deviceParseRuleInputSchema>) {
  const common = {
    matchKind: input.matchKind,
    expression: input.expression,
    scope: input.scope,
    whenProfile: input.whenProfile,
    whenFrom: input.whenFrom,
    whenSubject: input.whenSubject,
    sortOrder: input.sortOrder,
    isEnabled: input.isEnabled,
  };
  return input.target === 'identity'
    ? {
        ...common,
        target: 'identity' as const,
        keyKind: input.keyKind,
        metricCode: null,
        component: null,
        valueForm: null,
      }
    : {
        ...common,
        target: 'metric' as const,
        keyKind: null,
        metricCode: input.metricCode,
        component: input.component,
        valueForm: input.valueForm,
      };
}

/** Черновик правила в ту же форму строки, которой живёт разбор: проверяется ровно то, что поедет. */
function draftRow(input: z.infer<typeof deviceParseRuleInputSchema>): ParseRuleRow {
  const columns = toColumns(input);
  return {
    id: 'draft',
    target: columns.target,
    keyKind: columns.keyKind as ParseRuleRow['keyKind'],
    metricCode: columns.metricCode as MetricCode | null,
    component: columns.component as ComponentCode | null,
    valueForm: columns.valueForm as ParseValueForm | null,
    matchKind: columns.matchKind,
    expression: columns.expression,
    scope: columns.scope,
    whenProfile: columns.whenProfile,
    whenFrom: columns.whenFrom,
    whenSubject: columns.whenSubject,
  };
}

/** Отказ разбора правила — словами человеку: он его и писал. */
function ruleRefusal(e: unknown): never {
  if (e instanceof DeviceRuleError) throw err.unprocessable(e.message, { expression: e.message });
  throw e;
}

export default async function deviceMailRuleRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canReview = app.requirePermission('officeEquipment.telemetry');

  async function loadRecords(): Promise<RuleRecord[]> {
    return db
      .select({
        id: deviceMailParseRules.id,
        target: deviceMailParseRules.target,
        keyKind: deviceMailParseRules.keyKind,
        metricCode: deviceMailParseRules.metricCode,
        component: deviceMailParseRules.component,
        valueForm: deviceMailParseRules.valueForm,
        matchKind: deviceMailParseRules.matchKind,
        expression: deviceMailParseRules.expression,
        scope: deviceMailParseRules.scope,
        whenProfile: deviceMailParseRules.whenProfile,
        whenFrom: deviceMailParseRules.whenFrom,
        whenSubject: deviceMailParseRules.whenSubject,
        sortOrder: deviceMailParseRules.sortOrder,
        isEnabled: deviceMailParseRules.isEnabled,
        createdAt: deviceMailParseRules.createdAt,
        updatedAt: deviceMailParseRules.updatedAt,
        updatedByName: users.fullName,
      })
      .from(deviceMailParseRules)
      .leftJoin(users, eq(users.id, deviceMailParseRules.updatedBy))
      .orderBy(
        asc(deviceMailParseRules.target),
        asc(deviceMailParseRules.sortOrder),
        asc(deviceMailParseRules.id),
      );
  }

  r.get(
    '/rules',
    { preHandler: [app.authenticate, canReview] },
    async (): Promise<{ items: DeviceParseRuleDto[] }> => {
      const records = await loadRecords();
      const deletable = await deletableIds(records);
      return { items: records.map((row) => toDto(row, deletable.has(row.id))) };
    },
  );

  r.post(
    '/rules',
    { preHandler: [app.authenticate, canReview], schema: { body: deviceParseRuleInputSchema } },
    async (req, reply): Promise<DeviceParseRuleDto> => {
      const principal = requirePrincipal(req);
      // Выражение проверяется ДО записи: правило, которое не компилируется, доехало бы до разбора
      // и уронило бы письмо в `failed` — молча и у всех писем сразу.
      if (req.body.matchKind === 'regex') {
        try {
          assertSafeExpression(req.body.expression);
          new RegExp(req.body.expression, 'u');
        } catch (e) {
          ruleRefusal(e instanceof DeviceRuleError ? e : new DeviceRuleError(String(e)));
        }
      }
      const [row] = await db
        .insert(deviceMailParseRules)
        .values({
          ...toColumns(req.body),
          createdBy: principal.id,
          updatedBy: principal.id,
        })
        .onConflictDoNothing()
        .returning({ id: deviceMailParseRules.id });
      if (!row) throw err.unprocessable('Такое правило уже заведено');
      const records = await loadRecords();
      const created = records.find((record) => record.id === row.id)!;
      reply.code(201);
      return toDto(created, true);
    },
  );

  r.patch(
    '/rules/:id',
    {
      preHandler: [app.authenticate, canReview],
      schema: { params: idParams, body: deviceParseRuleInputSchema },
    },
    async (req): Promise<DeviceParseRuleDto> => {
      const principal = requirePrincipal(req);
      if (req.body.matchKind === 'regex') {
        try {
          assertSafeExpression(req.body.expression);
          new RegExp(req.body.expression, 'u');
        } catch (e) {
          ruleRefusal(e instanceof DeviceRuleError ? e : new DeviceRuleError(String(e)));
        }
      }
      const updated = await db
        .update(deviceMailParseRules)
        .set({ ...toColumns(req.body), updatedBy: principal.id, updatedAt: new Date() })
        .where(eq(deviceMailParseRules.id, req.params.id))
        .returning({ id: deviceMailParseRules.id });
      if (updated.length === 0) throw err.notFound('Правило не найдено');
      const records = await loadRecords();
      const deletable = await deletableIds(records);
      const record = records.find((row) => row.id === req.params.id)!;
      return toDto(record, deletable.has(record.id));
    },
  );

  r.delete(
    '/rules/:id',
    { preHandler: [app.authenticate, canReview], schema: { params: idParams } },
    async (req): Promise<{ ok: true }> => {
      const records = await loadRecords();
      const record = records.find((row) => row.id === req.params.id);
      if (!record) throw err.notFound('Правило не найдено');
      const deletable = await deletableIds(records);
      if (!deletable.has(record.id)) {
        throw err.unprocessable(
          'По этому правилу уже разбирали письма — его можно только выключить: выключенное объясняет, почему они прочитаны так',
        );
      }
      await db.delete(deviceMailParseRules).where(eq(deviceMailParseRules.id, req.params.id));
      return { ok: true };
    },
  );

  /**
   * Проверка черновика на живом письме. Ничего не пишет и ни на что не влияет — в этом и смысл:
   * посмотреть, что получится, человек обязан ДО того, как правило начнёт менять разбор всего парка.
   */
  r.post(
    '/rules/preview',
    {
      preHandler: [app.authenticate, canReview],
      schema: { body: deviceParseRulePreviewSchema },
    },
    async (req): Promise<DeviceParseRulePreviewDto> => {
      const [message] = await db
        .select({
          id: deviceMailMessages.id,
          objectKey: deviceMailMessages.s3ObjectKey,
          envelopeTo: deviceMailMessages.envelopeTo,
        })
        .from(deviceMailMessages)
        .where(eq(deviceMailMessages.id, req.body.messageId));
      if (!message) throw err.notFound('Письмо аппарата не найдено');
      if (!message.objectKey) {
        throw err.unprocessable(
          'У этого письма нет сырья: проверить правило не на чем — возьмите письмо посвежее',
        );
      }
      const raw = await getDeviceMailRaw(message.objectKey);
      if (!raw) {
        throw err.unprocessable('Сырьё письма вычищено по сроку хранения — проверять нечем');
      }

      const ctx = await parseDeviceMail(raw, { envelopeTo: message.envelopeTo });
      const rule = draftRow(req.body.rule);
      const profile = chooseProfile(ctx).profile.code;

      if (!ruleApplies(rule, ctx, profile)) {
        return {
          applies: false,
          found: false,
          rawValue: '',
          value: '',
          unitLabel: '',
          resolution: null,
          note: 'Условия правила к этому письму не подходят: профиль, отправитель или тема другие',
        };
      }

      let rawValue: string | null;
      try {
        rawValue = findByRule(rule, ctx);
      } catch (e) {
        ruleRefusal(e);
      }
      if (rawValue === null) {
        return {
          applies: true,
          found: false,
          rawValue: '',
          value: '',
          unitLabel: '',
          resolution: null,
          note: 'Правило подошло, но в письме ничего не нашло',
        };
      }

      if (rule.target === 'metric' && rule.metricCode) {
        const value = ruleNumber(rule, rawValue);
        return {
          applies: true,
          found: value !== null,
          rawValue,
          value: value ?? '',
          unitLabel: metricUnitLabels[metricUnits[rule.metricCode]],
          resolution: null,
          note:
            value === null
              ? 'Значение нашлось, но числом не читается — проверьте форму числа в правиле'
              : 'Показание ляжет в карточку, когда аппарат будет опознан',
        };
      }

      const value = normalizeIdentityValue(rawValue);
      const resolution = await resolveDeviceIdentity(db, {
        hints: {
          serial: rule.keyKind === 'serial' ? value : null,
          inventory: rule.keyKind === 'inventory' ? value : null,
          deviceName: rule.keyKind === 'deviceName' ? value : null,
          host: rule.keyKind === 'host' ? value : null,
          ip: null,
          model: null,
        },
      });
      const equipmentId = resolution.status === 'matched' ? resolution.equipmentId : null;
      let equipmentTitle = '';
      if (equipmentId) {
        const [unit] = await db
          .select({
            name: officeEquipment.name,
            inventoryNumber: officeEquipment.inventoryNumber,
            serialNumber: officeEquipment.serialNumber,
          })
          .from(officeEquipment)
          .where(eq(officeEquipment.id, equipmentId));
        if (unit) equipmentTitle = officeEquipmentTitle(unit);
      }
      return {
        applies: true,
        found: true,
        rawValue,
        value,
        unitLabel: '',
        resolution: { status: resolution.status, equipmentId, equipmentTitle },
        note:
          resolution.status === 'matched'
            ? `С этим ключом письмо опознаёт аппарат: ${equipmentTitle}`
            : resolution.status === 'ambiguous'
              ? 'Такой ключ подходит нескольким карточкам — письмо осталось бы в очереди'
              : 'Ключ вынулся, но карточки с ним нет: письмо ждало бы привязки',
      };
    },
  );
}
