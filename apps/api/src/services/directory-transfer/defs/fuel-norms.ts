import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  FUEL_NORM_UNITS,
  fuelNormUnitLabels,
  type FuelNormUnit,
  vehicleLabel,
  type VehicleOwnership,
} from '@technic/contracts';
import { db } from '../../../db/client';
import { vehicleFuelNorms, vehicles } from '../../../db/schema';
import { decimalCell, parseChoice, parseDecimal } from '../cells';
import { directory, type AnyDirectory } from '../types';
import { normalizeRegistration } from './vehicles';

/**
 * Обмен файлом для норм расхода топлива (план `docs/fuel-norms-plan.md`, §6; ADR 0073).
 *
 * ГЛАВНОЕ РЕШЕНИЕ ОПИСАНИЯ: **файл возит срез, а не историю** (Р21а). У машины столько версий
 * нормы, сколько было приказов, но ключ строки в файле уникален — повтор движок отвергает целиком,
 * и выгрузка с историей не загрузилась бы обратно ни разу. Поэтому в файле одна строка на машину:
 * действующая на сегодня норма, а колонка «Действует с» — справочная, только на чтение.
 *
 * Отсюда четыре следствия, и каждое куплено разбором движка:
 *
 * 1. **`id(row)` — идентификатор МАШИНЫ, а не версии.** Иначе вчерашний файл после нового приказа
 *    упал бы целиком: движок ищет строку по проставленному идентификатору и не находит снятую
 *    версию.
 * 2. **`load()` отдаёт и машины без норм** — с пустыми ставками. Это отступление от контракта
 *    («весь справочник, включая погашенные»), названное сознательно: снятая версия не должна
 *    ронять файл, а пустая строка законна — она означает «нормы у машины нет».
 * 3. **`create()` недостижим и бросает.** Всякий опознанный госномер находится в срезе, значит
 *    движок зовёт только `update()`; строку с неопознанным номером отсекает `check()` до
 *    транзакции. Молчаливая заглушка здесь была бы хуже броска: она теряла бы строку без следа.
 * 4. **`update()` заводит НОВУЮ версию**, а не правит найденную: правка ставки — это новый приказ
 *    (Р6), и переписывать им прошлые отчёты нельзя. Дата новой версии — начало текущего месяца,
 *    как и в окне (Р7); повтор в том же месяце перезаписывает версию месяца (Р7а).
 *
 * `check()` различает ТРИ состояния строки, а не два: пустая норма законна (у большинства парка
 * нормы нет, и нетронутый файл обязан загружаться), частично заполненная — отвергается. Последнее
 * не педантизм: `update()` с пустыми числами нарушил бы `NOT NULL`, а движок переводит в
 * человеческий текст только конфликт ключа и ссылки — остальное ушло бы пятисоткой.
 */

interface NormRow {
  vehicleId: string;
  registrationNumber: string | null;
  ownership: VehicleOwnership;
  description: string;
  categoryName: string | null;
  typeName: string;
  modelName: string | null;
  /** Действующая версия, если она есть: срез отдаёт и машины без норм. */
  normId: string | null;
  effectiveFrom: string | null;
  unit: FuelNormUnit | null;
  winterRate: string | null;
  summerRate: string | null;
  fuelType: string | null;
  note: string | null;
}

interface NormModel {
  vehicleId: string;
  /** Нормализованный госномер — ключ строки; по нему же она ищется среди заведённых. */
  registrationKey: string;
  registrationNumber: string;
  vehicleTitle: string;
  effectiveFrom: string;
  unit: FuelNormUnit | '';
  winterRate: string;
  summerRate: string;
  fuelType: string;
  note: string;
}

interface Env {
  /** Госномер (нормализованный) → машина: по нему строка файла ищет карточку. */
  byRegistration: Map<string, { id: string; title: string }>;
}

/*
 * Нормализация госномера берётся у справочника техники, а не пишется заново: она обязана совпадать
 * с `vehicle_reg_normalize` базы знак в знак — кириллические буквы номера заменяются латинскими
 * двойниками, и своя копия правила разошлась бы с индексом на первом же «У702АС 777».
 */
const normalizeReg = normalizeRegistration;

/**
 * Подписи единиц для разбора: `parseChoice` принимает и подпись, и код, поэтому список — это ровно
 * то, что печатает выгрузка. Второго словаря здесь нет намеренно: разойдись он с подписями
 * контрактов — файл, который портал только что отдал, он же и отверг бы.
 */
const UNIT_CHOICES = fuelNormUnitLabels;

const fuelNormsDirectory = directory<NormRow, NormModel, Env>({
  key: 'fuel-norms',

  async env() {
    /*
     * Машины с госномером и без предложений аренды: предложение живёт в той же таблице, но нормой
     * не нормируется — приказ адресован машине парка, а не строке прайса арендодателя.
     */
    const rows = await db
      .select({
        id: vehicles.id,
        registrationNumber: vehicles.registrationNumber,
        ownership: vehicles.ownership,
        description: vehicles.description,
        registrationNumberNormalized: vehicles.registrationNumberNormalized,
      })
      .from(vehicles)
      .where(and(isNull(vehicles.deletedAt), sql`${vehicles.registrationNumber} IS NOT NULL`));
    return {
      byRegistration: new Map(
        rows
          .filter((row) => row.registrationNumberNormalized)
          .map((row) => [
            row.registrationNumberNormalized!,
            { id: row.id, title: row.registrationNumber ?? row.description },
          ]),
      ),
    };
  },

  columns() {
    return [
      {
        header: 'Госномер',
        width: 16,
        hint: 'Госномер машины парка — по нему строка ищет карточку техники',
        get: (m) => m.registrationNumber,
        set: (m, text) => {
          m.registrationNumber = text.trim();
          m.registrationKey = normalizeReg(text);
        },
      },
      {
        header: 'Техника',
        width: 34,
        hint: 'Подпись машины — справочно, загрузка её не читает',
        get: (m) => m.vehicleTitle,
      },
      {
        header: 'Действует с',
        width: 14,
        hint: 'Дата действующей версии — справочно: правка ставок заводит новую версию с 1-го числа текущего месяца',
        get: (m) => m.effectiveFrom,
      },
      {
        header: 'Единица',
        width: 12,
        hint: `Единица нормы: ${Object.values(fuelNormUnitLabels).join(' или ')}`,
        get: (m) => (m.unit === '' ? '' : fuelNormUnitLabels[m.unit]),
        set: (m, text, ctx) => {
          if (text.trim() === '') {
            m.unit = '';
            return;
          }
          const parsed = parseChoice(text, UNIT_CHOICES, ctx, 'Единица');
          if (parsed !== undefined) m.unit = parsed;
        },
      },
      {
        header: 'Зимняя ставка',
        width: 14,
        hint: 'Литры на 100 км либо на моточас — по выбранной единице',
        get: (m) => decimalCell(m.winterRate),
        set: (m, text, ctx) => {
          const parsed = parseDecimal(text, ctx, 'Зимняя ставка');
          if (parsed !== undefined) m.winterRate = parsed;
        },
      },
      {
        header: 'Летняя ставка',
        width: 14,
        get: (m) => decimalCell(m.summerRate),
        set: (m, text, ctx) => {
          const parsed = parseDecimal(text, ctx, 'Летняя ставка');
          if (parsed !== undefined) m.summerRate = parsed;
        },
      },
      {
        header: 'Вид топлива',
        width: 12,
        hint: 'Справочно: в сверке не участвует',
        get: (m) => m.fuelType,
        set: (m, text) => {
          m.fuelType = text.trim();
        },
      },
      {
        header: 'Примечание',
        width: 30,
        get: (m) => m.note,
        set: (m, text) => {
          m.note = text.trim();
        },
      },
    ];
  },

  help() {
    return [
      'Нормы расхода топлива по машинам парка (docs/fuel-norms-plan.md).',
      'Файл возит СРЕЗ: одна строка на машину — норма, действующая на сегодня. История приказов в файл не выгружается и им не правится.',
      'Правка ставки заводит НОВУЮ версию нормы с 1-го числа текущего месяца: прошлые периоды считаются прежней ставкой.',
      'Повторная правка в том же месяце перезаписывает версию этого месяца, а не заводит вторую.',
      'Строка без ставок означает «нормы у машины нет» — так выгружаются машины, которым норму ещё не заводили.',
      'Заполнять норму нужно целиком: единица и обе ставки. Частично заполненная строка отвергается до записи.',
      'Машины без госномера и предложения аренды в файл не попадают: строка опознаётся госномером.',
    ];
  },

  async load() {
    /*
     * Срез: машина плюс её действующая версия, если она есть. Боковой поиск максимума даты — тот
     * же, каким расчёт ищет норму смены, только на сегодняшний день.
     */
    const norm = db
      .select({
        id: vehicleFuelNorms.id,
        vehicleId: vehicleFuelNorms.vehicleId,
        effectiveFrom: vehicleFuelNorms.effectiveFrom,
        unit: vehicleFuelNorms.unit,
        winterRate: vehicleFuelNorms.winterRate,
        summerRate: vehicleFuelNorms.summerRate,
        fuelType: vehicleFuelNorms.fuelType,
        note: vehicleFuelNorms.note,
        rank: sql<number>`row_number() OVER (PARTITION BY ${vehicleFuelNorms.vehicleId}
          ORDER BY ${vehicleFuelNorms.effectiveFrom} DESC)`.as('rank'),
      })
      .from(vehicleFuelNorms)
      .where(
        and(
          isNull(vehicleFuelNorms.deletedAt),
          sql`${vehicleFuelNorms.effectiveFrom} <= CURRENT_DATE`,
        ),
      )
      .as('norm');

    const rows = await db
      .select({
        vehicleId: vehicles.id,
        registrationNumber: vehicles.registrationNumber,
        ownership: vehicles.ownership,
        description: vehicles.description,
        categoryName: sql<string | null>`NULL`,
        typeName: sql<string>`''`,
        modelName: sql<string | null>`NULL`,
        normId: norm.id,
        effectiveFrom: norm.effectiveFrom,
        unit: norm.unit,
        winterRate: norm.winterRate,
        summerRate: norm.summerRate,
        fuelType: norm.fuelType,
        note: norm.note,
      })
      .from(vehicles)
      .leftJoin(norm, and(eq(norm.vehicleId, vehicles.id), eq(norm.rank, 1)))
      .where(and(isNull(vehicles.deletedAt), sql`${vehicles.registrationNumber} IS NOT NULL`))
      .orderBy(vehicles.registrationNumberNormalized, desc(norm.effectiveFrom));
    return rows as NormRow[];
  },

  id: (row) => row.vehicleId,

  model(row) {
    return {
      vehicleId: row.vehicleId,
      registrationKey: normalizeReg(row.registrationNumber ?? ''),
      registrationNumber: row.registrationNumber ?? '',
      vehicleTitle: vehicleLabel({
        ownership: row.ownership,
        description: row.description,
        registrationNumber: row.registrationNumber,
        categoryName: row.categoryName,
        typeName: row.typeName,
        modelName: row.modelName,
      }),
      effectiveFrom: row.effectiveFrom ?? '',
      unit: row.unit ?? '',
      winterRate: row.winterRate ?? '',
      summerRate: row.summerRate ?? '',
      fuelType: row.fuelType ?? '',
      note: row.note ?? '',
    };
  },

  blank() {
    return {
      vehicleId: '',
      registrationKey: '',
      registrationNumber: '',
      vehicleTitle: '',
      effectiveFrom: '',
      unit: '',
      winterRate: '',
      summerRate: '',
      fuelType: '',
      note: '',
    };
  },

  keyOf: (m) => m.registrationKey,
  titleOf: (m) => m.registrationNumber || m.vehicleTitle,

  check(model, ctx, env) {
    const vehicle = env.byRegistration.get(model.registrationKey);
    if (!vehicle) {
      ctx.fail(`Машина с госномером «${model.registrationNumber}» в парке не заведена`);
      return;
    }
    model.vehicleId = vehicle.id;

    const filled = [model.unit !== '', model.winterRate !== '', model.summerRate !== ''];
    // Пустая строка законна: у машины просто нет нормы, и нетронутый файл обязан загружаться.
    if (filled.every((value) => !value)) return;
    if (!filled.every((value) => value)) {
      ctx.fail('Норма заполняется целиком: единица и обе ставки');
      return;
    }
    for (const [label, value] of [
      ['Зимняя ставка', model.winterRate],
      ['Летняя ставка', model.summerRate],
    ] as const) {
      const rate = Number(value.replace(',', '.'));
      if (!Number.isFinite(rate) || rate <= 0 || rate > 999) {
        ctx.fail(`${label}: число больше нуля и не больше 999`);
      }
    }
  },

  create() {
    /*
     * Недостижимо по устройству движка: строка ищется среди всего, что вернул `load()`, а срез
     * содержит и машины без норм — значит опознанный номер находится всегда, и зовётся `update()`.
     * Неопознанный отсекает `check()` до транзакции. Бросок, а не молчание: если ветка однажды
     * оживёт, строка обязана об этом сказать, а не потеряться.
     */
    throw new Error('Норма расхода заводится правкой строки среза: create недостижим');
  },

  async update(tx, row, model, _env, actorUserId) {
    if (model.unit === '' || model.winterRate === '' || model.summerRate === '') return;
    // Новая версия — с 1-го числа текущего месяца (Р7); повтор того же месяца перезаписывает её.
    const effectiveFrom = new Date();
    const month = `${effectiveFrom.getFullYear()}-${String(effectiveFrom.getMonth() + 1).padStart(2, '0')}-01`;
    const values = {
      vehicleId: row.vehicleId,
      effectiveFrom: month,
      unit: model.unit,
      winterRate: model.winterRate.replace(',', '.'),
      summerRate: model.summerRate.replace(',', '.'),
      fuelType: model.fuelType,
      note: model.note,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
    const [existing] = await tx
      .select({ id: vehicleFuelNorms.id })
      .from(vehicleFuelNorms)
      .where(
        and(
          eq(vehicleFuelNorms.vehicleId, row.vehicleId),
          eq(vehicleFuelNorms.effectiveFrom, month),
          isNull(vehicleFuelNorms.deletedAt),
        ),
      );
    if (existing) {
      await tx
        .update(vehicleFuelNorms)
        .set({
          unit: values.unit,
          winterRate: values.winterRate,
          summerRate: values.summerRate,
          fuelType: values.fuelType,
          note: values.note,
          updatedBy: actorUserId,
          updatedAt: new Date(),
        })
        .where(eq(vehicleFuelNorms.id, existing.id));
      return;
    }
    await tx.insert(vehicleFuelNorms).values(values);
  },
});

export const fuelNormDirectories: AnyDirectory[] = [fuelNormsDirectory];

/** Единицы — списком: их же показывает подсказка колонки и принимает разбор. */
export const FUEL_NORM_UNIT_CHOICES = FUEL_NORM_UNITS;
