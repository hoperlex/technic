import type { DeviceIdentityHints, DeviceMailContext, DeviceProfile } from '@technic/contracts';
import {
  DEVICE_NAME_LABELS,
  HOST_LABELS,
  INVENTORY_LABELS,
  MODEL_LABELS,
  findIpAddress,
  findLabeledValue,
  findSerial,
} from '../extract';
import { emptyIdentityHints, limitIdentityHints, type ProfileParseResult } from './types';

/**
 * Профиль «не поняли» (Р13 плана `docs/office-equipment-mail-telemetry-plan.md`).
 *
 * **Это законный исход, а не заглушка.** Письмо, формат которого не узнал ни один вендорский
 * профиль, обязано доехать до базы со статусом `unrecognized` и лежать в очереди разбора: именно из
 * этой очереди берутся образцы для следующего профиля. Молчаливое выбрасывание лишило бы нас
 * единственного источника знаний о парке — а парк в пилоте разномастный.
 *
 * Отсюда два свойства, которые выглядят странно по отдельности и осмысленны вместе:
 *
 * 1. **`detect` всегда отвечает минимальной уверенностью, а не нулём.** Ноль означал бы «этот
 *    профиль не подходит», и реестр (Ш5), выбирающий максимум, остался бы без выбора вовсе — то
 *    есть без профиля, то есть без строки. Минимум означает «подходит хуже всех, но подходит»,
 *    и любой вендорский профиль, узнавший своё письмо, побеждает его числом.
 * 2. **Наблюдений и событий — ноль, а подсказки опознания вычитываются.** Чисел мы не поняли и
 *    угадывать их не станем: наблюдение с угаданной меткой хуже отсутствующего, потому что попадёт
 *    в ряд счётчика и испортит будущие месячные дельты. А вот серийник, имя и IP человеку в
 *    очереди нужны ровно затем, чтобы он мог привязать письмо к карточке руками (§6, Р20), и
 *    вычитываются они общими средствами `extract.ts`, без всякого знания о вендоре.
 */

/** Минимальная уверенность: «подходит хуже всех, но подходит» (см. п. 1 выше). */
export const UNKNOWN_PROFILE_CONFIDENCE = 0.01;

/**
 * Версия разбора. Поднимается руками при изменении правил — по ней отбираются письма на
 * перечитывание (Р26), и `unknown` здесь не исключение: подсказки опознания он вычитывает, а
 * значит их правка меняет то, что увидит человек в очереди.
 */
export const UNKNOWN_PROFILE_VERSION = 1;

function identityHints(ctx: DeviceMailContext): DeviceIdentityHints {
  const hints = emptyIdentityHints();
  hints.serial = findSerial(ctx);
  hints.inventory = findLabeledValue(ctx, INVENTORY_LABELS);
  hints.deviceName = findLabeledValue(ctx, DEVICE_NAME_LABELS);
  hints.host = findLabeledValue(ctx, HOST_LABELS);
  hints.model = findLabeledValue(ctx, MODEL_LABELS);
  hints.ip = findIpAddress(ctx);
  // Границы контракта — здесь, а не надеждой на прошивку: длинное значение в метке уводило бы
  // письмо в `failed` с пустым снимком, то есть вон из очереди образцов (см. `limitIdentityHints`).
  return limitIdentityHints(hints);
}

export const unknownProfile: DeviceProfile = {
  code: 'unknown',
  version: UNKNOWN_PROFILE_VERSION,
  detect: () => UNKNOWN_PROFILE_CONFIDENCE,
  parse: (ctx): ProfileParseResult => ({
    observations: [],
    events: [],
    identity: identityHints(ctx),
  }),
};
