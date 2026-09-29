/**
 * Путевой лист: бумага, с которой машина уходит в рейс, и строка журнала учёта (ADR 0037).
 * Снаружи берут `@entities/waybill` — внутренние модули слайса не видны, и перестроить его можно,
 * не трогая потребителей.
 *
 * `waybillKeys` живёт здесь со всеми семействами журнала — и здесь единственным. Пока своего слайса
 * у листов не было, такой же пустой ключ стоял в `entities/vehicle-request`, рядом с их ручками;
 * оба сняты вместе с переводом потребителей. Почему две копии одного кортежа были безопасны, а
 * правка одной из них — нет, сказано у самого ключа.
 *
 * PRINTING LIVES HERE, ATTACHING DOES NOT, and the two used to be listed side by side as waiting
 * for the same barrier. Printing asks the journal for a blank and marks the sheet as gone — nothing
 * but this slice is involved, so `ui/WaybillPrint.tsx` is at home. Attaching a scan to a sheet needs
 * the file slice as well (upload to storage, the shared list of links), and one entity may not reach
 * for another on its own layer: that cell is a feature, `@features/waybill-files`.
 */
export { waybillKeys } from './api/keys';
export { waybillsApi } from './api/waybillsApi';
export {
  ExportWaybillButton,
  type PrintTarget,
  PrintWaybillButton,
  WaybillPrintModal,
} from './ui/WaybillPrint';

/*
 * Warnings shown before a blank number is spent. The display is shared by every path that spends
 * one (route and weekly ESM-2 issue, the assignment doors); the doors keep only their adapters,
 * because the answers they read differ in shape.
 */
export { type WarnedSheet, WarnedSheetsConfirm, WaybillWarningList } from './ui/WaybillWarnings';

/*
 * Право перейти к бланку по его номеру. Журнал листов — отдельный экран без окна, и номер уводит
 * туда же, куда уводил; `null` вместо адреса оставляет номер текстом у роли, которой журнал не
 * положен.
 */
export { waybillLink } from './model/links';
export { waybillErrorMessage } from './model/errorMessage';
