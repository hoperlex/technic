/**
 * Правила разбора писем от аппаратов (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §6.2).
 *
 * Сценарий, а не сущность: слайс знает, что правило перекрывает профиль, что единица берётся из
 * реестра метрик, и что проверять правило надо на живом письме до сохранения.
 */
export { DeviceRulesBoard, RULES_EMPTY_TEXT } from './ui/DeviceRulesBoard';
export { DeviceRuleFormModal } from './ui/DeviceRuleFormModal';
export { useDeviceRulePreview, useDeviceRuleRemove, useDeviceRuleSave } from './model/actions';
