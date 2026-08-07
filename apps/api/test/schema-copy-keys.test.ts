import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../src/db/schema';

/**
 * Составные внешние ключи и режим `ON UPDATE` у них (ADR 0061).
 *
 * Второй колонкой в таком ключе всегда стоит **служебная копия** реквизита родителя (ADR 0007 §2):
 * тип машины в назначении, тип заявки, тип категории, роль арендодателя. Копия бывает двух родов, и
 * `ON UPDATE` — это ровно выбор между ними:
 *
 *   · **зеркало** — копия обязана совпадать с оригиналом всегда, следовать за ним ей нечем, кроме
 *     каскада (`cascade`);
 *   · **замок** — копия существует, чтобы запретить правку родителя, и отказ обязан быть словами
 *     сервера, а не ошибкой целостности (`no action` + проверка в маршруте).
 *
 * Умолчание Postgres (`NO ACTION`) означает «замок», и выбирается оно молчанием — из-за чего
 * справочник техники год отдавал 500 на смене типа у машины с назначением. Поэтому режим здесь
 * перечислен поимённо: новый составной ключ уронит тест, пока автор не назовёт его род.
 */

type Mode = 'зеркало' | 'замок';

const EXPECTED: Record<string, { mode: Mode; why: string }> = {
  // Копия типа НАЗНАЧЕННОЙ машины. Не читается ничем — цель ключа и только. Переклассификация
  // парка (ADR 0061) обычная работа справочника, и копия едет за машиной.
  vehicle_request_assignments_vehicle_type_fk: {
    mode: 'зеркало',
    why: 'тип назначенной машины — копия vehicles.vehicle_type_id (ADR 0061)',
  },
  // Копия ЗАКАЗАННОГО типа заявки. Здесь наоборот: сменить заказ под назначенной машиной нельзя
  // (ADR 0028 §9), и маршрут заявок отвечает на это 422 с объяснением.
  vehicle_request_assignments_ordered_type_fk: {
    mode: 'замок',
    why: 'заказ заявки не меняют под назначением — 422 в routes/vehicle-requests.ts (ADR 0059)',
  },
  // Роль и активность арендодателя в строке техники: ведёт их не приложение, а каскад (ADR 0018).
  vehicles_lessor_fk: {
    mode: 'зеркало',
    why: 'роль и активность арендодателя — копия counterparties (ADR 0018 §15)',
  },
  // Тип у модели, категории и ТТХ неизменяем by design: в схемах правки его нет вовсе, и «замок»
  // здесь ничего не запрещает — он просто никогда не срабатывает.
  vehicles_model_type_fk: { mode: 'замок', why: 'тип модели неизменяем (роут только на чтение)' },
  vehicles_category_type_fk: {
    mode: 'замок',
    why: 'тип категории неизменяем (updateVehicleCategorySchema его не принимает)',
  },
  vehicle_requests_category_type_fk: { mode: 'замок', why: 'тип категории неизменяем' },
  vehicle_category_spec_values_category_fk: { mode: 'замок', why: 'тип категории неизменяем' },
  vehicle_category_spec_values_type_spec_fk: {
    mode: 'замок',
    why: 'привязка ТТХ к типу не правится, а пересоздаётся (ADR 0016)',
  },
  // Документы водителей (ADR 0008, 0055). Тип документа неизменяем намеренно: удостоверение
  // не той системы квалификации аннулируют и выписывают заново — категории, открытые прежним
  // типом, при смене всё равно перестали бы ему принадлежать, и каскад одного ключа сломал бы
  // второй. Обе стороны — замки, и это решение, а не умолчание.
  person_credential_categories_credential_fk: {
    mode: 'замок',
    why: 'тип документа неизменяем: не тот тип — аннулирование и новый документ (ADR 0055)',
  },
  person_credential_categories_category_fk: {
    mode: 'замок',
    why: 'категория принадлежит своему виду документа навсегда (ADR 0008)',
  },
  // Недельная заявка (ADR 0085). Копия недели в строке заведена не ради чтения, а ради CHECK'а
  // «даты строки не выходят за пн–вс своей заявки»: межтабличной проверки в Postgres нет, и
  // сравнивать строку с неделей шапки больше нечем. Замок здесь — не запрет, а констатация: недели
  // у заявки не меняют вовсе, на другую неделю заводится новая (одна заявка на пару «объект +
  // неделя»), и схема правки `week_start` не принимает.
  weekly_items_week_fk: {
    mode: 'замок',
    why: 'неделя заявки неизменяема: на другую неделю заводится новая заявка (ADR 0085)',
  },
  weekly_items_category_type_fk: { mode: 'замок', why: 'тип категории неизменяем' },
};

/** Все составные внешние ключи схемы: имя → фактический `ON UPDATE`. */
function compositeForeignKeys(): Map<string, string> {
  const found = new Map<string, string>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    for (const fk of getTableConfig(value).foreignKeys) {
      if (fk.reference().foreignColumns.length < 2) continue;
      found.set(fk.getName(), fk.onUpdate ?? 'no action');
    }
  }
  return found;
}

describe('служебные копии под составными ключами', () => {
  const actual = compositeForeignKeys();

  it('перечислены все до одного — новый ключ требует решения, а не умолчания', () => {
    expect([...actual.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s — %o', (name, { mode }) => {
    expect(actual.get(name)).toBe(mode === 'зеркало' ? 'cascade' : 'no action');
  });

  it('назначение: тип машины едет за машиной, тип заказа — нет', () => {
    // Пара, ради которой заведён реестр: два ключа одной таблицы с противоположными родами.
    // Смешать их значит либо снова отдавать 500 на переклассификации, либо молча переписывать
    // заказ площадки при правке справочника.
    expect(actual.get('vehicle_request_assignments_vehicle_type_fk')).toBe('cascade');
    expect(actual.get('vehicle_request_assignments_ordered_type_fk')).toBe('no action');
  });
});
