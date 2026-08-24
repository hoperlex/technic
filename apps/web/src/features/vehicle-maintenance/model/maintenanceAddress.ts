import { useSearchParams } from 'react-router';
import { useAddressParam, type AddressParam } from '@shared/lib';

/**
 * Открытая сводка ТО названа в адресе: `?maintenance=<vehicleId>` (Р14в, Р29), а конкретный акт в
 * ней — вторым ключом `&record=<maintenanceId>` (план `docs/auto-parts-plan.md`, Р14).
 *
 * Механику вкладка «Показания» не видна вовсе, и строки «Техники» — в гараже и в справочнике —
 * его единственный вход в журнал обслуживания. Вход этот — переход, а не подстройка экрана:
 * ссылку отправляют коллеге («посмотри, что с этой машиной»), «назад» обязано закрыть окно, а
 * перезагрузка — оставить его открытым. Состояние в `useState` не даёт ни того, ни другого, ни
 * третьего, и справочник техники именно им и открывал окно, пока ключ жил только в гараже.
 *
 * Ключ один на оба входа намеренно: окно одно и то же (`VehicleMaintenanceModal`), и второе имя
 * означало бы, что ссылка из гаража и ссылка из справочника открывают разные вещи.
 *
 * **Второй ключ называет документ, а не машину.** Лента журнала склада ссылается на акт («Акт
 * № 128»), и одной машины ей мало: в истории десятки строк, а движение объясняет ровно одна.
 * Поэтому `record` — не самостоятельный адрес, а уточнение к первому: сводка открывается по
 * `maintenance`, а `record` говорит ей, к какой строке прокрутиться и какие строки раскрыть.
 * Отсюда и закрытие: снимаются оба ключа одной правкой адреса — оставленный `record` уточнял бы
 * окно, которого больше нет.
 *
 * Модулем сценария, а не строками в каждом из входов: имя ключа — договор между ними, и разъехаться
 * ему негде только пока оно написано один раз.
 */

const MAINTENANCE_PARAM = 'maintenance';
const RECORD_PARAM = 'record';

export interface MaintenanceAddress extends AddressParam {
  /** Акт, названный в адресе, — `null`, если адрес называет только машину. */
  recordId: string | null;
  /** Ссылка на конкретный акт: её строит лента журнала склада. */
  hrefRecord: (vehicleId: string, recordId: string) => string;
}

/**
 * `allowed` — есть ли у смотрящего `vehicleMaintenance.read`. Без права ключ не читается: у
 * списков, из которых открывают сводку, права свои (`garage.read`, `directories.write`), и
 * присланная ссылка иначе открывала бы окно, которому нечего показать.
 *
 * В `id` — машина, чья сводка открыта; в `recordId` — акт, к которому надо прокрутиться.
 */
export function useMaintenanceAddress(allowed: boolean): MaintenanceAddress {
  const vehicle = useAddressParam(MAINTENANCE_PARAM, allowed);
  const [params, setParams] = useSearchParams();

  return {
    ...vehicle,
    recordId: allowed ? params.get(RECORD_PARAM) || null : null,
    /*
     * Закрытие снимает оба ключа ОДНОЙ правкой адреса. Два последовательных `setSearchParams`
     * читают один и тот же снимок текущих ключей, и второй затёр бы первый — `record` пережил бы
     * закрытие окна и уточнял бы пустоту.
     */
    close: () => {
      const next = new URLSearchParams(params);
      next.delete(MAINTENANCE_PARAM);
      next.delete(RECORD_PARAM);
      setParams(next, { replace: true });
    },
    hrefRecord: (vehicleId, recordId) => {
      const next = new URLSearchParams(params);
      next.set(MAINTENANCE_PARAM, vehicleId);
      next.set(RECORD_PARAM, recordId);
      return `?${next.toString()}`;
    },
  };
}

/**
 * Тот же второй ключ глазами блока обслуживания: ему нужно только прочитать акт.
 *
 * Ключ из адреса не вычёркивается после раскрытия, и это разница с «одноразовой подсветкой»:
 * перезагрузка обязана оставить окно ровно таким, каким его прислали ссылкой. Одноразовость живёт
 * не в адресе, а в самом раскрытии — строку, свёрнутую руками, блок обратно не разворачивает.
 *
 * Отдельным хуком, а не полем `useMaintenanceAddress`: блок стоит и в карточке машины, где ключа
 * `maintenance` в адресе нет вовсе, — там он живёт композицией, а не окном.
 */
export function useMaintenanceRecordAddress(allowed: boolean): string | null {
  const [params] = useSearchParams();
  return allowed ? params.get(RECORD_PARAM) || null : null;
}
