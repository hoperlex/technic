import { DIRECTORY_KEYS, type DirectoryKey } from '@technic/contracts';
import type { AnyDirectory } from './types';
import { organizationalDirectories } from './defs/org';
import { wasteDirectories } from './defs/waste';
import { vehicleDirectories } from './defs/vehicles';
import { officeDirectories } from './defs/office';
import { mechDirectories } from './defs/mech';
import { staffDirectories } from './defs/staff';

/**
 * Какие справочники участвуют в обмене (ADR 0073). Описания сгруппированы по предметным областям
 * ровно так, как их ведут в портале: организационные, вывоз мусора, техника, оргтехника,
 * механизация, кадры.
 *
 * Порядок берётся из `DIRECTORY_KEYS` в общем пакете, а не из порядка импортов: список, по
 * которому портал рисует вкладку, и список, по которому сервер отдаёт файлы, должен быть один —
 * иначе появится кнопка, ведущая в 404, или справочник, о котором знает только сервер.
 */
const DEFINITIONS: readonly AnyDirectory[] = [
  ...organizationalDirectories,
  ...wasteDirectories,
  ...vehicleDirectories,
  ...officeDirectories,
  ...mechDirectories,
  ...staffDirectories,
];

const BY_KEY = new Map<DirectoryKey, AnyDirectory>(DEFINITIONS.map((d) => [d.key, d]));

/** Справочники в порядке показа. Ключ без описания сюда не попадёт — это проверяет тест. */
export const directories: readonly AnyDirectory[] = DIRECTORY_KEYS.map((key) =>
  BY_KEY.get(key),
).filter((d): d is AnyDirectory => d !== undefined);

export function directoryFor(key: DirectoryKey): AnyDirectory | undefined {
  return BY_KEY.get(key);
}
