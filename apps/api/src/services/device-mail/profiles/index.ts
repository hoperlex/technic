import type { DeviceMailContext } from '@technic/contracts';
import type { DeviceProfile } from './types';
import { UNKNOWN_PROFILE_CONFIDENCE, unknownProfile } from './unknown';

/**
 * Реестр профилей разбора (план `docs/office-equipment-mail-telemetry-plan.md`, §8).
 *
 * ЭТО ШОВ ОРКЕСТРАТОРА, а не файл пакета работ: профильные агенты пишут каждый свой файл и отдают
 * строку сюда текстом. Общий у них ровно этот реестр, и вставлять её самим значило бы либо получить
 * конфликт, либо перезаписать соседнюю правку, сделанную минуту назад.
 *
 * ПОРЯДОК В МАССИВЕ НИЧЕГО НЕ РЕШАЕТ. Спор решает число: профиль отвечает уверенностью 0…1, и
 * выигрывает наибольшая. Письма вендоров похожи, и «кто первым объявлен» — это правило, которое
 * ломается ровно в тот день, когда второй вендор начнёт слать письма того же вида.
 */
const PROFILES: readonly DeviceProfile[] = [
  /* B1 (Ricoh), B2 (Kyocera), B3 (HP) встают сюда своими строками. */
  unknownProfile,
];

export interface ProfileChoice {
  profile: DeviceProfile;
  confidence: number;
  /** Узнал ли кто-то, кроме «не понял»: от этого зависит статус письма (`unrecognized`). */
  recognized: boolean;
}

/**
 * Выбор профиля. `unknown` побеждает только тогда, когда не узнал никто, — и это законный исход, а
 * не отказ: письмо доедет до базы, ляжет в очередь, и из неё возьмут образец для следующего
 * профиля. Молчаливое выбрасывание лишило бы нас единственного источника знаний о парке.
 */
export function chooseProfile(ctx: DeviceMailContext): ProfileChoice {
  let best: DeviceProfile = unknownProfile;
  let bestConfidence = -1;
  for (const profile of PROFILES) {
    const confidence = profile.detect(ctx);
    if (confidence > bestConfidence) {
      best = profile;
      bestConfidence = confidence;
    }
  }
  return {
    profile: best,
    confidence: bestConfidence,
    recognized: best.code !== 'unknown' && bestConfidence > UNKNOWN_PROFILE_CONFIDENCE,
  };
}

export { PROFILES };
