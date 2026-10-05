import { useState, type ReactNode } from 'react';
import { App, Form, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatVehicleRequestNumber,
  isOdometerMaintenance,
  isPassengerTypeForm,
  maintenanceBasisOf,
  typeWaybillFormOf,
  type CreateVehicleTypeInput,
  type UpdateVehicleTypeInput,
  type VehicleTypeDto,
  type VehicleTypeLinearSwitchPreviewDto,
  type VehicleTypeLinearSwitchResultDto,
} from '@technic/contracts';
import {
  vehicleClassificationKeys,
  vehicleKindKeys,
  vehicleKindsApi,
  vehicleTypeErrorMessage as errorMessage,
  vehicleTypeKeys,
  vehicleTypesApi,
} from '@entities/vehicle-type';
import { trailerKeys } from '@entities/vehicle-trailer';
import { isApiError } from '@shared/api';
import { formatDateOnly } from '@shared/lib';
import { FormModal } from '@shared/ui';
import { VehicleTypeFormFields, type VtFormValues } from '../ui/VehicleTypeFormFields';

export interface VehicleTypeEditorController {
  actions: {
    create: () => void;
    edit: (type: VehicleTypeDto) => void;
  };
  node: ReactNode;
}

function plural(n: number, one: string, few: string, many: string): string {
  const tail = n % 100;
  const last = n % 10;
  if (tail >= 11 && tail <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

const requestsCount = (n: number) => `${n} ${plural(n, 'заявка', 'заявки', 'заявок')}`;

const unhitchedNotice = (trailers: number, vehicles: number) =>
  `Тип стал легковым, и лист по нему выписывается формой № 3: отцеплено ` +
  `${trailers} ${plural(trailers, 'прицеп', 'прицепа', 'прицепов')} ` +
  `у ${vehicles} ${plural(vehicles, 'машины', 'машин', 'машин')} — граф прицепа в этом бланке нет`;

function switchConsequence(next: boolean, count: number): string {
  const subject = `${requestsCount(count)} ${plural(count, 'продолжит', 'продолжат', 'продолжат')}`;
  return next
    ? `${subject} вестись по неделям: ЭСМ-2 портал выписывает по ним сам, дни им не планируются.`
    : `${subject} вестись по дням: распланированные дни остаются в рейсах, недельные листы им не выписываются.`;
}

/** Own the whole create/edit transaction, including the guarded linear-mode switch. */
export function useVehicleTypeEditor(): VehicleTypeEditorController {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleTypeDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<VtFormValues>();

  const kindsQuery = useQuery({
    queryKey: vehicleKindKeys.root,
    queryFn: () => vehicleKindsApi.list({ pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });

  const invalidateTypes = () => {
    void queryClient.invalidateQueries({ queryKey: vehicleTypeKeys.root });
    // A type name is also the label of every classification row derived from that type.
    void queryClient.invalidateQueries({ queryKey: vehicleClassificationKeys.root });
  };

  const create = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({
      sortOrder: 100,
      isActive: true,
      isPassenger: false,
      isLinear: false,
      maintenanceByOdometer: false,
    });
    setOpen(true);
  };

  const edit = (type: VehicleTypeDto) => {
    setRecord(type);
    form.resetFields();
    form.setFieldsValue({
      kindId: type.kindId,
      code: type.code,
      name: type.name,
      description: type.description,
      sortOrder: type.sortOrder,
      isActive: type.isActive,
      isPassenger: isPassengerTypeForm(type.waybillFormCode),
      isLinear: type.isLinear,
      maintenanceByOdometer: isOdometerMaintenance(type.maintenanceBasis),
    });
    setOpen(true);
  };

  const createMutation = useMutation({
    mutationFn: (body: CreateVehicleTypeInput) => vehicleTypesApi.create(body),
    onSuccess: () => {
      message.success('Сохранено');
      invalidateTypes();
      setOpen(false);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const confirmLinearSwitch = (preview: VehicleTypeLinearSwitchPreviewDto, typeName: string) =>
    new Promise<boolean>((resolve) => {
      // The counter includes archived and out-of-scope requests, while the visible list cannot.
      const hidden = preview.count - preview.archivedCount - preview.requests.length;
      modal.confirm({
        title: `Переключить режим заказов типа «${typeName}»?`,
        width: 560,
        content: (
          <Space orientation="vertical" size={8} style={{ display: 'flex' }}>
            <span>{switchConsequence(preview.next, preview.count)}</span>
            {preview.requests.length > 0 && (
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {preview.requests.map((request) => (
                  <li key={request.num}>
                    {formatVehicleRequestNumber(request.num)} — {request.objectName},{' '}
                    {formatDateOnly(request.dateFrom)}
                    {request.dateTo ? ` — ${formatDateOnly(request.dateTo)}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {preview.archivedCount > 0 && (
              <Typography.Text type="secondary">
                Ещё {requestsCount(preview.archivedCount)} в архиве.
              </Typography.Text>
            )}
            {hidden > 0 && (
              <Typography.Text type="secondary">
                Ещё {requestsCount(hidden)} на площадках, которых вы не ведёте.
              </Typography.Text>
            )}
          </Space>
        ),
        okText: 'Переключить',
        cancelText: 'Отмена',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });

  const runLinearSwitch = async (
    type: VehicleTypeDto,
    next: boolean,
  ): Promise<VehicleTypeLinearSwitchResultDto | null> => {
    for (let attempt = 0; ; attempt++) {
      const preview = await vehicleTypesApi.linearSwitchPreview(type.id, next);
      if (preview.count > 0 && !(await confirmLinearSwitch(preview, type.name))) return null;
      try {
        return await vehicleTypesApi.switchLinear(type.id, {
          isLinear: next,
          ...(preview.count > 0 ? { fingerprint: preview.fingerprint } : {}),
        });
      } catch (error) {
        // A changed request set invalidates the preview. Re-read and ask once with current data.
        const retry = isApiError(error) && (error.status === 409 || error.status === 422);
        if (!retry || attempt > 0) throw error;
        message.error(error.message);
      }
    }
  };

  const submitEdit = async (values: VtFormValues, type: VehicleTypeDto) => {
    const body: UpdateVehicleTypeInput = {
      name: values.name,
      description: values.description ?? '',
      sortOrder: values.sortOrder,
      isActive: values.isActive,
      waybillFormCode: typeWaybillFormOf(values.isPassenger ?? false),
      maintenanceBasis: maintenanceBasisOf(values.maintenanceByOdometer ?? false),
    };
    const nextLinear = values.isLinear ?? false;
    setSaving(true);
    let switched = false;
    try {
      // Switching comes first so cancelling the guarded step cannot persist unrelated edits.
      if (nextLinear !== type.isLinear) {
        const result = await runLinearSwitch(type, nextLinear);
        if (!result) return;
        switched = true;
        // Keep retry idempotent if the following PATCH fails after a successful switch.
        setRecord(result.type);
        if (result.frozenNow > 0) {
          const nums = result.frozenNums.slice(0, 10).map(formatVehicleRequestNumber).join(', ');
          const rest = result.frozenNums.length - 10;
          message.info(
            `Режим переключён. На прежнем режиме ${requestsCount(result.frozenNow)}: ` +
              `${nums}${rest > 0 ? ` и ещё ${rest}` : ''}`,
          );
        }
      }
      const saved = await vehicleTypesApi.update(type.id, body);
      message.success('Сохранено');
      // This warning reports a successful action's secondary database effect, not a form error.
      if (saved.unhitchedTrailers)
        message.warning(unhitchedNotice(saved.unhitchedTrailers, saved.unhitchedVehicles), 8);
      void queryClient.invalidateQueries({ queryKey: trailerKeys.root });
      setOpen(false);
    } catch (error) {
      message.error(
        switched
          ? `Режим переключён, остальные поля не сохранены: ${errorMessage(error)}. Повторите сохранение.`
          : errorMessage(error),
      );
    } finally {
      // The type may have changed even when the descriptive PATCH failed.
      invalidateTypes();
      setSaving(false);
    }
  };

  const submit = (values: VtFormValues) => {
    if (record) {
      void submitEdit(values, record);
      return;
    }
    createMutation.mutate({
      kindId: values.kindId!,
      code: values.code!,
      name: values.name!,
      description: values.description ?? '',
      sortOrder: values.sortOrder ?? 100,
      isActive: values.isActive ?? true,
      waybillFormCode: typeWaybillFormOf(values.isPassenger ?? false),
      isLinear: values.isLinear ?? false,
      maintenanceBasis: maintenanceBasisOf(values.maintenanceByOdometer ?? false),
    });
  };

  return {
    actions: { create, edit },
    node: (
      <FormModal
        title={record ? 'Редактирование типа' : 'Новый тип ТС'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={createMutation.isPending || saving}
        width={520}
      >
        <Form form={form} layout="vertical" onFinish={submit}>
          <VehicleTypeFormFields
            form={form}
            record={record}
            kinds={kindsQuery.data?.items ?? []}
            kindsLoading={kindsQuery.isLoading}
          />
        </Form>
      </FormModal>
    ),
  };
}
