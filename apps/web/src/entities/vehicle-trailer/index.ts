/**
 * Прицепы: свой реестр и привязка к тягачу (план `docs/vehicle-trailers-plan.md`). Снаружи берут
 * `@entities/vehicle-trailer` — внутренние модули слайса не видны.
 */
export { vehicleTrailersApi } from './api/vehicleTrailersApi';
export { trailerHitchTargetsKey, trailerKeys } from './api/keys';
export { trailerPickerQuery, trailerSlotsQuery } from './api/queries';
/** Слова портала о снятых привязках — общие для всех дверей, которые их снимают (§4.2.3). */
export { unhitchedNotice } from './model/notices';
/** Состав машины в её же карточке — показом, без правки: привязку ставят у прицепа (§4.2). */
export { VehicleTrailersField } from './ui/VehicleTrailersField';
