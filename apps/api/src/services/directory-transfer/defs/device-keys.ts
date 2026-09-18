import { and, eq, isNull } from 'drizzle-orm';
import {
  DEVICE_MANUAL_IDENTITY_KINDS,
  deviceIdentityLabels,
  normalizeIdentityValue,
  type DeviceManualIdentityKind,
} from '@technic/contracts';
import { db } from '../../../db/client';
import { deviceMailIdentities, officeEquipment } from '../../../db/schema';
import { directory, type AnyDirectory, type RowContext, type Tx } from '../types';
import { insertDeviceMailIdentityTx } from '../../device-mail/apply';

/**
 * КЛЮЧИ ОПОЗНАНИЯ АППАРАТОВ в обмене файлом (ADR 0073, план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §8).
 *
 * ЗАЧЕМ ЗДЕСЬ, А НЕ СВОИМ ИМПОРТЁРОМ. Парк — три сотни карточек, и заводить ключи по одному
 * нажатием в реестре означало бы три сотни нажатий. Механика обмена уже отвечает на «как назвать
 * ошибку строки», «что считать изменением» и «когда файл не применяется целиком»; свой импортёр
 * отвечал бы на то же самое во второй раз и иначе.
 *
 * ПРИВЯЗКА К КАРТОЧКЕ ИДЁТ ПО ИНВЕНТАРНОМУ НОМЕРУ, а не по серийному: инвентарный заполнен у всех
 * карточек парка, серийный — у трёх четвертей. Файл, опирающийся на серийник, отверг бы каждую
 * четвёртую строку по причине, которую человек не может исправить в этом же файле.
 *
 * ЗАЛИВКА ЗАВОДИТ КЛЮЧИ И НЕ ПРИМЕНЯЕТ ИХ К ОЧЕРЕДИ. Триста строк, каждая из которых тянет пачку
 * писем и запись наблюдений, — это транзакция, которую нельзя ни объяснить, ни отменить.
 * Применение осталось отдельным действием реестра: там человек видит число заранее и нажимает сам.
 *
 * СНЯТЫХ ПРИВЯЗОК В ФАЙЛЕ НЕТ ВОВСЕ: они ничего не опознают, а в файле выглядели бы работающими —
 * и первая же выгрузка-загрузка вернула бы их к жизни. История снятий живёт в реестре.
 */

interface KeyRow {
  id: string;
  kind: string;
  value: string;
  equipmentId: string;
  inventoryNumber: string;
  note: string;
}

interface KeyModel {
  kind: string;
  value: string;
  inventoryNumber: string;
  note: string;
  /** Карточка, найденная по инвентарному номеру: заполняет `check()`, читает `create()`. */
  equipmentId: string;
}

interface KeyEnv {
  /** Инвентарный номер в той же форме, в какой его держит частичный уникальный индекс карточки. */
  byInventory: Map<string, string>;
}

const KIND_BY_LABEL = new Map<string, DeviceManualIdentityKind>(
  DEVICE_MANUAL_IDENTITY_KINDS.map((kind) => [deviceIdentityLabels[kind].toLowerCase(), kind]),
);

/** Ключ и в файле, и в реестре зовётся одинаково: словарь подписи один на портал. */
function labelOf(kind: string): string {
  return deviceIdentityLabels[kind as DeviceManualIdentityKind] ?? kind;
}

export const deviceKeyDirectories: readonly AnyDirectory[] = [
  directory<KeyRow, KeyModel, KeyEnv>({
    key: 'device-mail-keys',
    env: async () => {
      const rows = await db
        .select({ id: officeEquipment.id, inventoryNumber: officeEquipment.inventoryNumber })
        .from(officeEquipment)
        .where(isNull(officeEquipment.deletedAt));
      const byInventory = new Map<string, string>();
      for (const row of rows) {
        const key = normalizeIdentityValue(row.inventoryNumber);
        if (key !== '') byInventory.set(key, row.id);
      }
      return { byInventory };
    },
    columns: () => [
      {
        header: 'Чем связываем',
        width: 22,
        hint: `Один из: ${DEVICE_MANUAL_IDENTITY_KINDS.map(labelOf).join(', ')}`,
        get: (m) => labelOf(m.kind),
        set: (m, text, ctx) => {
          const kind = KIND_BY_LABEL.get(text.trim().toLowerCase());
          if (!kind) {
            ctx.fail(
              `неизвестный род ключа «${text}»: ожидается один из — ${DEVICE_MANUAL_IDENTITY_KINDS.map(labelOf).join(', ')}`,
            );
            return;
          }
          m.kind = kind;
        },
      },
      {
        header: 'Значение ключа',
        width: 28,
        hint: 'Так, как его пишет сам аппарат: серийный номер, имя устройства, сетевое имя',
        get: (m) => m.value,
        set: (m, text, ctx) => {
          const value = normalizeIdentityValue(text);
          if (value === '') {
            ctx.fail('пустое значение ключа: опознавать по нему нечего');
            return;
          }
          m.value = value;
        },
      },
      {
        header: 'Инвентарный номер аппарата',
        width: 26,
        hint: 'Инвентарный номер карточки, к которой ведёт ключ',
        get: (m) => m.inventoryNumber,
        set: (m, text) => {
          m.inventoryNumber = text.trim();
        },
      },
      {
        header: 'Примечание',
        width: 34,
        hint: 'Откуда взято значение: табличка на корпусе, выгрузка ИТ-службы',
        get: (m) => m.note,
        set: (m, text) => {
          m.note = text.trim();
        },
      },
    ],
    help: () => [
      'Ключ опознания связывает письмо аппарата с его карточкой.',
      'Само письмо находит карточку только по серийному номеру; остальные ключи работают отсюда.',
      'Загрузка ЗАВОДИТ ключи, но не применяет их к накопленным письмам:',
      'это делается кнопкой «Применить к очереди» в реестре ключей — там видно, сколько писем затронет.',
      'Снятые ключи в файл не попадают: они ничего не опознают, а их история живёт в реестре.',
    ],
    load: async () => {
      const rows = await db
        .select({
          id: deviceMailIdentities.id,
          kind: deviceMailIdentities.keyKind,
          value: deviceMailIdentities.keyValue,
          equipmentId: deviceMailIdentities.equipmentId,
          inventoryNumber: officeEquipment.inventoryNumber,
          note: deviceMailIdentities.note,
        })
        .from(deviceMailIdentities)
        .innerJoin(officeEquipment, eq(officeEquipment.id, deviceMailIdentities.equipmentId))
        .where(and(isNull(deviceMailIdentities.revokedAt), isNull(officeEquipment.deletedAt)))
        .orderBy(deviceMailIdentities.keyValue);
      return rows;
    },
    id: (row) => row.id,
    model: (row) => ({
      kind: row.kind,
      value: row.value,
      inventoryNumber: row.inventoryNumber,
      note: row.note,
      equipmentId: row.equipmentId,
    }),
    blank: () => ({ kind: 'serial', value: '', inventoryNumber: '', note: '', equipmentId: '' }),
    // Ключ строки — род плюс значение: то же, чем его держит уникальный индекс живых привязок.
    keyOf: (m) => (m.value === '' ? '' : `${m.kind}|${m.value}`),
    titleOf: (m) => `${labelOf(m.kind)} ${m.value}`,
    check: (m: KeyModel, ctx: RowContext, env: KeyEnv) => {
      const inventory = normalizeIdentityValue(m.inventoryNumber);
      if (inventory === '') {
        ctx.fail('не указан инвентарный номер аппарата: к чему привязывать ключ — неизвестно');
        return;
      }
      const equipmentId = env.byInventory.get(inventory);
      if (!equipmentId) {
        ctx.fail(`карточки с инвентарным номером «${m.inventoryNumber}» нет среди живых`);
        return;
      }
      m.equipmentId = equipmentId;
    },
    create: async (tx: Tx, m: KeyModel, _env: KeyEnv, actorUserId: string) => {
      await insertDeviceMailIdentityTx(tx, {
        equipmentId: m.equipmentId,
        kind: m.kind as DeviceManualIdentityKind,
        value: m.value,
        note: m.note,
        confirmedBy: actorUserId,
      });
    },
    update: async (tx: Tx, row: KeyRow, m: KeyModel) => {
      // Правится примечание и КАРТОЧКА: перенос ключа на другой аппарат — законная работа
      // («ошиблись строкой при заведении»), и файл с предпросмотром показывает её человеку до
      // записи. Род и значение при этом менять нельзя — это и есть сам ключ, а его правка
      // означала бы новую привязку рядом с брошенной.
      await tx
        .update(deviceMailIdentities)
        .set({ equipmentId: m.equipmentId, note: m.note })
        .where(eq(deviceMailIdentities.id, row.id));
    },
  }),
];
