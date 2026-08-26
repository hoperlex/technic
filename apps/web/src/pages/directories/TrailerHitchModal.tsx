import { App, Form, Select, type FormInstance } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TRAILER_HITCH_POSITIONS,
  type TrailerHitchPosition,
  trailerTitle,
  vehicleOptionLabel,
  type VehicleTrailerDto,
} from '@technic/contracts';
import { trailerHitchTargetsKey, trailerKeys, vehicleTrailersApi } from '@entities/vehicle-trailer';
import { AutoSelect, FormModal } from '@shared/ui';
import { vehiclesApi } from '../../api/resources';
import { errorMessage } from '../../utils/format';
import { hitchedVehicleLabel } from './trailerGrid';

/**
 * За какой машиной стоит прицеп — окно привязки (план `docs/vehicle-trailers-plan.md`, §4.2.1).
 *
 * Отдельным модулем от вкладки: у окна два своих запроса — парк машин и состав выбранной, — и во
 * вкладке они читались как чужие. Переназначение здесь одна команда, а не «отцепить и прицепить»
 * двумя шагами, между которыми можно застрять.
 *
 * Форму окно получает готовой: значения в неё кладёт вкладка в тот же миг, когда открывает окно на
 * строке прицепа.
 */

export interface HitchFormValues {
  vehicleId: string;
  position: TrailerHitchPosition;
}

export function TrailerHitchModal({
  /** Прицеп, для которого открыто окно; `null` — окно закрыто. */
  trailer,
  form,
  onClose,
}: {
  trailer: VehicleTrailerDto | null;
  form: FormInstance<HitchFormValues>;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const watchVehicleId = Form.useWatch('vehicleId', form);
  const watchPosition = Form.useWatch('position', form);

  // Машины для окна привязки — только пока окно открыто: список парка нужен одному этому окну, а
  // вкладку открывают ради самих прицепов.
  const { data: vehiclesData, isLoading: vehiclesLoading } = useQuery({
    queryKey: trailerHitchTargetsKey,
    queryFn: () =>
      vehiclesApi.list({
        page: 1,
        pageSize: 500,
        ownership: 'own',
        sortBy: 'registrationNumber',
        sortOrder: 'asc',
      }),
    enabled: !!trailer,
  });

  /**
   * Тягачом может быть собственная живая машина, **бланк которой не «форма № 3»**: граф прицепа у
   * неё нет вовсе (ADR 0071), и закрепление описывало бы то, что негде напечатать. До типа
   * `tractor_trailers` список не сужаем — прицеп цепляют и к бортовому, и к самосвалу (§4.2.3).
   * Списанная машина отпадает по тому же правилу, что и списанный прицеп; удалённые не приходят
   * вовсе — `includeDeleted` в запросе не задан.
   */
  const hitchVehicleOptions = (vehiclesData?.items ?? [])
    .filter((v) => !v.deletedAt && v.status !== 'retired' && v.waybillFormCode !== 'leg3')
    .map((v) => ({ value: v.id, label: vehicleOptionLabel(v) }));

  // Машина, за которой прицеп стоит сейчас, могла выпасть из списка — например, у её типа сменили
  // бланк на «форму № 3». Без этой добавки поле показало бы сырой uuid вместо машины; выбрать её
  // заново нельзя — снять привязку можно, вернуть уже нет.
  const current = trailer?.hitchedVehicle ?? null;
  const vehicleOptions =
    current && !hitchVehicleOptions.some((o) => o.value === current.id)
      ? [
          ...hitchVehicleOptions,
          {
            value: current.id,
            label: `${hitchedVehicleLabel(current)} (прицеп ей больше не полагается)`,
            disabled: true,
          },
        ]
      : hitchVehicleOptions;

  /**
   * Состав выбранной машины — им же и отвечает `hitchedVehicleId` в контракте списка. Спрашиваем
   * до нажатия, а не разбираем ответ после: слот освобождает сама команда, и человек имеет право
   * знать, кого он вытесняет, **пока** ещё может передумать.
   */
  const { data: slotsData } = useQuery({
    queryKey: trailerKeys.slots(watchVehicleId),
    queryFn: () =>
      vehicleTrailersApi.list({ page: 1, pageSize: 10, hitchedVehicleId: watchVehicleId }),
    enabled: !!trailer && !!watchVehicleId,
  });

  // Сам перемещаемый прицеп жильцом слота не считается: «переставить в тот же слот» — не вытеснение.
  const occupantOf = (position: TrailerHitchPosition): VehicleTrailerDto | null =>
    (slotsData?.items ?? []).find((t) => t.hitchPosition === position && t.id !== trailer?.id) ??
    null;

  const positionOptions = TRAILER_HITCH_POSITIONS.map((p) => {
    const busy = watchVehicleId ? occupantOf(p) : null;
    return { value: p, label: busy ? `Прицеп ${p} — занят: ${trailerTitle(busy)}` : `Прицеп ${p}` };
  });
  const displaced = watchVehicleId && watchPosition ? occupantOf(watchPosition) : null;

  const hitchMut = useMutation({
    mutationFn: (v: HitchFormValues) =>
      vehicleTrailersApi.hitch(trailer!.id, { vehicleId: v.vehicleId, position: v.position }),
    onSuccess: (res) => {
      message.success('Прицеп поставлен за машину');
      // Вытеснение — второе изменение в базе, о котором не просили: показываем словами сервера и
      // дольше обычного, чтобы его успели прочитать.
      if (res.notice) message.warning(res.notice, 8);
      void qc.invalidateQueries({ queryKey: trailerKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title={trailer ? `За какой машиной: ${trailerTitle(trailer)}` : ''}
      open={!!trailer}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={hitchMut.isPending}
      okText={trailer?.hitchedVehicle ? 'Переставить' : 'Прицепить'}
      width={520}
    >
      <Form form={form} layout="vertical" onFinish={(v) => hitchMut.mutate(v)}>
        <Form.Item
          name="vehicleId"
          label="Машина"
          rules={[{ required: true, message: 'Выберите машину' }]}
          extra="Собственные машины, в бланке которых есть графы прицепа: у формы № 3 их нет"
        >
          <AutoSelect
            options={vehicleOptions}
            loading={vehiclesLoading}
            showSearch
            optionFilterProp="label"
            placeholder="Госномер или марка"
            notFoundContent="Подходящих машин нет"
          />
        </Form.Item>
        <Form.Item
          name="position"
          label="Слот бланка"
          rules={[{ required: true, message: 'Выберите слот' }]}
          extra={
            displaced
              ? `Слот занят: «${trailerTitle(displaced)}» будет отцеплен`
              : 'Граф прицепа в бланке 4-П две — третий печатать негде'
          }
        >
          <Select<TrailerHitchPosition> options={positionOptions} />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
