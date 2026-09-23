import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
  vehicleLabel,
  type VehicleDto,
  type VehicleRouteDto,
  vehicleStatusLabels,
} from '@technic/contracts';
import { driverKeys, driversApi } from '@entities/driver';
import { vehicleKeys, vehiclesApi } from '@entities/vehicle';
import { vehicleRouteKeys, vehicleRoutesApi } from '@entities/vehicle-route';

/**
 * Чем наполнены поля выбора в окне коррекции рейса (ADR 0101): машина, водитель, прицепы.
 *
 * Вынесено из самого окна (`VehicleRouteCorrectionModal.tsx`) по границе предмета — тем же
 * разрезом, что и перечень последствий рядом: там форма (поля, правила, отправка), здесь три
 * запроса со своими правилами отбора, которые к вводу не относятся вовсе. Ратчет качества
 * (`scripts/quality.mjs`) считает строки у окна, и списки тянули его вверх, ничего не добавляя
 * форме.
 *
 * ГЛАВНОЕ, ЧТО ДЕРЖИТ ЭТОТ МОДУЛЬ: **отбор здесь исторический, а не сегодняшний**. Исправляют
 * прошедший день, и списки обязаны показывать то, чем и кем работали ТОГДА: списанную с тех пор
 * машину (Р17) и уволившегося после рейса водителя (ADR 0101 п. 15). Сведи любой из двух списков
 * к обычному «что доступно сейчас» — и рейс за прошлую неделю станет не на кого и не на что
 * выписать.
 *
 * Последствия и блокировки сюда не переехали намеренно: их считает сервер (`correctionPreview`),
 * и держит их само окно — от них зависит, отпустит ли оно нажатие. Заодно это оставило все сырые
 * ключи коррекции в одном файле: `rawKeyFiles` в `scripts/quality.mjs` считает ФАЙЛЫ, и разрез,
 * разносящий литералы по двум, растит долг, не добавив ни одного нового ключа. Здешние три
 * запроса идут семействами из `entities/<сущность>/api/keys` — перевод карточки рейса и его листа на
 * семейства остаётся отдельной работой, как и сказано в шапке `vehicleRouteKeys`.
 */

interface Args {
  route: VehicleRouteDto | null;
  /** Машина, стоящая в поле сейчас: от неё зависят и прицепы, и список водителей. */
  vehicleId: string | undefined;
  withTrailer: boolean;
}

export function useRouteCorrectionChoices({ route, vehicleId, withTrailer }: Args) {
  /**
   * Парк целиком, включая списанную и стоящую в ремонте технику (Р17): истории статусов у машины
   * нет, а исправляют задним числом как раз ту единицу, которую с тех пор списали. Состояние
   * названо в строке выбора — «поехала машина, которой сегодня нет в строю» человек должен видеть.
   */
  const { data: fleet, isFetching: fleetLoading } = useQuery({
    queryKey: vehicleKeys.ownForCorrection(),
    queryFn: () =>
      vehiclesApi.list({
        ownership: 'own',
        page: 1,
        pageSize: 500,
        sortBy: 'registrationNumber',
        sortOrder: 'asc',
      }),
    enabled: !!route,
  });

  const vehicleOptions = useMemo(
    () =>
      (fleet?.items ?? []).map((v: VehicleDto) => ({
        value: v.id,
        label: [
          vehicleLabel(v),
          v.modelName,
          v.status === 'active' ? null : vehicleStatusLabels[v.status].toLowerCase(),
        ]
          .filter((s): s is string => !!s)
          .join(' · '),
      })),
    [fleet],
  );

  /**
   * Прицепы, закреплённые за **выбранной** машиной (§4.2.2 плана прицепов): её здесь меняют, и
   * спрашиваем о той, что стоит в поле, — закрепление прежней описывало бы уже не тот рейс.
   */
  const { data: suggestion } = useQuery({
    queryKey: vehicleRouteKeys.suggest(vehicleId, route?.routeDate),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: vehicleId!, date: route!.routeDate }),
    enabled: !!route && !!vehicleId,
  });

  /**
   * Кто мог сесть за эту машину **в день рейса**: отбор исторический (ADR 0101 п. 15), и уволенный
   * после рейса человек из списка не пропадает — иначе лист за прошлую неделю нельзя было бы
   * выписать на того, кто её и отработал.
   */
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: driverKeys.available({ vehicleId, on: route?.routeDate, withTrailer }),
    queryFn: () =>
      driversApi.available({ vehicleId: vehicleId!, on: route!.routeDate, withTrailer }),
    enabled: !!route && !!vehicleId,
  });

  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      driverDocumentGapsHint(d.gaps, d.credentialTypeCode),
      d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  return {
    vehicleOptions,
    fleetLoading,
    driverOptions,
    driversLoading,
    suggestion,
    /** Тип выбранной машины: по нему поле прицепов решает, что ей вообще можно прицепить. */
    vehicleTypeId: fleet?.items.find((v) => v.id === vehicleId)?.vehicleTypeId,
  };
}
