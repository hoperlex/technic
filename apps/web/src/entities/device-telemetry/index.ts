/**
 * Телеметрия аппарата: показания счётчиков и события, которые прислал он сам (план
 * `docs/office-equipment-mail-telemetry-plan.md`, §10).
 *
 * Отдельным слайсом, а не частью `office-equipment`: карточка — то, что о технике знает человек, а
 * телеметрия — то, что о ней сказала она сама. У них разные писатели (почтовый приём, дальше
 * коллектор — Р4), разное устаревание и разные ключи кэша.
 *
 * Снаружи берут `@entities/device-telemetry` — внутренние модули слайса не видны, и линт границ
 * запрещает путь вида `@entities/device-telemetry/api/keys` прямо.
 */
export { deviceTelemetryApi, type DeviceTelemetryParams } from './api/deviceTelemetryApi';
export { deviceTelemetryKeys } from './api/keys';
