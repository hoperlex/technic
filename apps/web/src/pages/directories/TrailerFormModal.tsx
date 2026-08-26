import { App, Form, Input, InputNumber, Select, type FormInstance } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type TrailerKind,
  trailerTitle,
  type VehicleStatus,
  type VehicleTrailerDto,
} from '@technic/contracts';
import { trailerKeys, vehicleTrailersApi } from '@entities/vehicle-trailer';
import { FormGrid, FormModal } from '@shared/ui';
import { errorMessage } from '../../utils/format';
import { kindOptions, statusOptions } from './trailerGrid';

/**
 * Карточка прицепа — заведение и правка одним окном (приём `VehicleTypeFormFields`).
 *
 * Отдельным модулем от вкладки: карточка повторяет СТС целиком, и вопросов у неё больше, чем
 * колонок у списка. Внутри окна живёт и сохранение: тело запроса — часть того же разговора с
 * сервером, что и поля, и разъехаться им нельзя.
 *
 * Форму окно не заводит, а получает: значения в неё кладёт вкладка, открывая окно на строке, —
 * так «открыть» и «заполнить» остаются одним движением, а не эффектом после отрисовки.
 */

export interface TrailerFormValues {
  kind: TrailerKind;
  model: string;
  registrationNumber: string;
  vin?: string;
  passportNumber?: string;
  manufacturedYear?: number | null;
  color?: string;
  maxMassKg?: number | null;
  curbMassKg?: number | null;
  status: VehicleStatus;
  note?: string;
}

/** Тот же текст, что и в `refine` контракта: форма и сервер обязаны отказывать одними словами. */
const MASS_ORDER_MESSAGE = 'Масса в снаряжённом состоянии не больше технически допустимой';

export function TrailerFormModal({
  open,
  /** Правка — прицеп, который правят; заведение — `null`. */
  record,
  form,
  onClose,
}: {
  open: boolean;
  record: VehicleTrailerDto | null;
  form: FormInstance<TrailerFormValues>;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();

  const saveMut = useMutation({
    mutationFn: (v: TrailerFormValues) => {
      // Привязки в теле нет ни у заведения, ни у правки: её меняет команда, и второй путь к тому
      // же значению отличался бы надёжностью (Р14).
      const body = {
        kind: v.kind,
        model: v.model,
        registrationNumber: v.registrationNumber,
        vin: v.vin ?? '',
        passportNumber: v.passportNumber ?? '',
        manufacturedYear: v.manufacturedYear ?? null,
        color: v.color ?? '',
        maxMassKg: v.maxMassKg ?? null,
        curbMassKg: v.curbMassKg ?? null,
        status: v.status,
        note: v.note ?? '',
      };
      return record ? vehicleTrailersApi.update(record.id, body) : vehicleTrailersApi.create(body);
    },
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: trailerKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title={record ? `Прицеп: ${trailerTitle(record)}` : 'Новый прицеп'}
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={saveMut.isPending}
      width={720}
    >
      {/* Карточка повторяет СТС и идёт его порядком: реквизиты списывают с бумаги подряд, и
          переставленное поле здесь стоит лишнего возврата глазами к скану. */}
      <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
        <FormGrid>
          <Form.Item
            name="kind"
            label="Тип ТС"
            rules={[{ required: true, message: 'Выберите тип' }]}
          >
            <Select<TrailerKind> options={kindOptions} />
          </Form.Item>
          <Form.Item
            name="registrationNumber"
            label="Госномер"
            rules={[{ required: true, message: 'Укажите госномер' }]}
          >
            <Input maxLength={20} />
          </Form.Item>
          <FormGrid.Full>
            <Form.Item
              name="model"
              label="Марка"
              rules={[{ required: true, message: 'Укажите марку прицепа' }]}
              extra="Печатается в графе «(марка)» путевого листа: «ШМИТЦ SPR-24»"
            >
              <Input maxLength={100} />
            </Form.Item>
          </FormGrid.Full>
          <Form.Item name="vin" label="VIN">
            <Input maxLength={40} placeholder="Или заводской номер шасси" />
          </Form.Item>
          <Form.Item name="passportNumber" label="ПТС">
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="manufacturedYear" label="Год выпуска">
            <InputNumber style={{ width: '100%' }} min={1900} max={2100} controls={false} />
          </Form.Item>
          <Form.Item name="color" label="Цвет">
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="maxMassKg" label="Технически допустимая макс. масса, кг">
            <InputNumber style={{ width: '100%' }} min={1} />
          </Form.Item>
          {/* Порядок масс проверяется только когда заданы обе: реквизиты списывают с бумаги, а
              бумага бывает неполной — тем же правилом, что и `refine` контракта. */}
          <Form.Item
            name="curbMassKg"
            label="Масса в снаряжённом состоянии, кг"
            dependencies={['maxMassKg']}
            rules={[
              {
                validator: (_rule, value: number | null | undefined) => {
                  const max = form.getFieldValue('maxMassKg') as number | null | undefined;
                  return value == null || max == null || value <= max
                    ? Promise.resolve()
                    : Promise.reject(new Error(MASS_ORDER_MESSAGE));
                },
              },
            ]}
          >
            <InputNumber style={{ width: '100%' }} min={1} />
          </Form.Item>
          <Form.Item name="status" label="Состояние">
            <Select<VehicleStatus> options={statusOptions} />
          </Form.Item>
          <FormGrid.Full>
            <Form.Item name="note" label="Примечание">
              <Input.TextArea rows={2} maxLength={2000} />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}
