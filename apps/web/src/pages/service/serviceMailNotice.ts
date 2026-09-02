import type { App } from 'antd';
import { moduleMailOutcomeLabels, type ModuleMailOutcome } from '@technic/contracts';

/** Тосты окна: то же, что отдаёт `App.useApp()`, — свой тип антом наружу не выведен. */
type MessageApi = ReturnType<typeof App.useApp>['message'];

/**
 * Судьба письма службе после **удавшегося** действия (Р67): заявка заведена, отменена или письмо
 * послано заново — а письма нет.
 *
 * Отказом это не является: операция прошла, поля тут ни при чём, и поправить его человек не может
 * ничем, кроме обращения к администратору. Поэтому ответ — тост, а не пометка поля: у службы нет
 * учётки в портале, и «служба не оповещена» надо узнать сразу, а не когда за заявкой не приехали.
 *
 * Собрано отдельным модулем ради исключения из ADR 0094: список исключений в
 * `scripts/check-form-blockers.mjs` — пофайловый, и вписать в него `ServiceRequestForm` значило бы
 * снять правило со всей формы заявки, со всех её полей разом. Здесь снимать нечего: поля нет, а
 * `ModuleMailOutcome` на входе не даёт модулю превратиться в общий вход для любых тостов.
 *
 * `queued`, `not_needed` и пустой исход молчат: очередь — обычный ход, `not_needed` означает, что
 * писать было не о чем (состав никого не назначил), а `null` приходит от правки заявки, которая
 * письма и не шлёт.
 */
export function reportServiceMail(
  message: MessageApi,
  outcome: ModuleMailOutcome | null | undefined,
): void {
  if (!outcome || outcome === 'queued' || outcome === 'not_needed') return;
  message.warning(moduleMailOutcomeLabels[outcome]);
}
