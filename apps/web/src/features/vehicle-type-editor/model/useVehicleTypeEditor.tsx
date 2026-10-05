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

/** Russian count-word agreement: 1 заявка, 2 заявки, 5 заявок. */
function plural(n: number, one: string, few: string, many: string): string {
  const tail = n % 100;
  const last = n % 10;
  if (tail >= 11 && tail <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

// «12 заявок»: the count word for requests is built in one place and read in four.
const requestsCount = (n: number) => `${n} ${plural(n, 'заявка', 'заявки', 'заявок')}`;

/**
 * What to say about hitches released by moving a type to «форма № 3» (docs/vehicle-trailers-plan.md
 * §4.2.3, the fourth door). Two numbers, not one: editing one directory row affects the whole type,
 * and the trailer count alone does not name the scale — «3 at three vehicles» and «3 at one» are
 * different news.
 *
 * The phrase starts with what the user clicked: the form has the «Легковой транспорт» checkbox,
 * with «форма № 3» only as its caption. Starting with the blank would leave the user to rebuild the
 * chain «checkbox → blank → trailer fields» while looking at an unhitching they never asked for.
 */
const unhitchedNotice = (trailers: number, vehicles: number) =>
  `Тип стал легковым, и лист по нему выписывается формой № 3: отцеплено ` +
  `${trailers} ${plural(trailers, 'прицеп', 'прицепа', 'прицепов')} ` +
  `у ${vehicles} ${plural(vehicles, 'машины', 'машин', 'машин')} — граф прицепа в этом бланке нет`;

/**
 * The switch consequence in words, always with its direction. The flag of the type is switched,
 * while requests caught in work keep their previous mode (ADR 0107 §1): not saying which mode
 * leaves the user guessing what happens to the paperwork of orders already running.
 */
function switchConsequence(next: boolean, count: number): string {
  const subject = `${requestsCount(count)} ${plural(count, 'продолжит', 'продолжат', 'продолжат')}`;
  return next
    ? `${subject} вестись по неделям: ЭСМ-2 портал выписывает по ним сам, дни им не планируются.`
    : `${subject} вестись по дням: распланированные дни остаются в рейсах, недельные листы им не выписываются.`;
}

/**
 * Own the whole create/edit transaction, including the guarded linear-mode switch (ADR 0107).
 *
 * The linear flag has its own endpoint with a preview and a confirmation (ADR 0107 §5): isLinear
 * never travels in the PATCH body, and the server answers 422 if it does. Only creation sends it as
 * an ordinary field — a new type has no requests a switch could catch.
 */
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
    // A type name is also the label of every classification row derived from that type (ADR 0028).
    void queryClient.invalidateQueries({ queryKey: vehicleClassificationKeys.root });
  };

  const create = () => {
    setRecord(null);
    form.resetFields();
    // The default blank is 4-П (ADR 0065): an own vehicle always has a waybill, and «passenger» is
    // the exception marked by hand. Maintenance marking defaults the same way as its column: while
    // a type is unmarked, maintenance is not asked of its vehicles (R13).
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

  // On creation the linear flag goes as an ordinary field: a new type has no requests that a switch
  // could catch, and never will.
  const createMutation = useMutation({
    mutationFn: (body: CreateVehicleTypeInput) => vehicleTypesApi.create(body),
    onSuccess: () => {
      message.success('Сохранено');
      invalidateTypes();
      setOpen(false);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  /**
   * The confirmation dialog: what exactly happens and to which requests. A Promise rather than a
   * callback because the switch is one step of «preview → question → write», and the sequence has
   * to read top to bottom.
   */
  const confirmLinearSwitch = (preview: VehicleTypeLinearSwitchPreviewDto, typeName: string) =>
    new Promise<boolean>((resolve) => {
      // The list is shorter than the counter by exactly what this user cannot see in the request
      // list anyway: the archive is an administrator area and foreign sites are outside the scope
      // (ADR 0107 §7). The difference must be stated, or the numbers on screen stop adding up.
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

  /**
   * Switch the flag through its own endpoint: preview → confirmation → write. null means the user
   * declined and nothing was written.
   */
  const runLinearSwitch = async (
    type: VehicleTypeDto,
    next: boolean,
  ): Promise<VehicleTypeLinearSwitchResultDto | null> => {
    for (let attempt = 0; ; attempt++) {
      const preview = await vehicleTypesApi.linearSwitchPreview(type.id, next);
      // An empty set has nothing to confirm: no request will be caught by the switch, and the
      // server accepts the write without a fingerprint (ADR 0107 §6).
      if (preview.count > 0 && !(await confirmLinearSwitch(preview, type.name))) return null;
      try {
        return await vehicleTypesApi.switchLinear(type.id, {
          isLinear: next,
          ...(preview.count > 0 ? { fingerprint: preview.fingerprint } : {}),
        });
      } catch (error) {
        // Neither 409 («the request set changed») nor 422 («confirmation required») wrote anything:
        // the portal re-reads the preview and asks again with the new list in front of the user.
        // A second such refusal goes to the user — the directory is being edited concurrently,
        // and resolving that is not the loop's job.
        const retry = isApiError(error) && (error.status === 409 || error.status === 422);
        if (!retry || attempt > 0) throw error;
        // A server refusal, not an empty form field (ADR 0094): the toast answers the endpoint's
        // response, and the re-read list follows right after it.
        message.error(error.message);
      }
    }
  };

  /**
   * An edit is up to two requests, and their order is not a matter of taste: first the flag switch
   * through its own endpoint, then the PATCH of the other fields. The reverse order would save the
   * descriptive edits and lose the main change when the confirmation is declined.
   */
  const submitEdit = async (values: VtFormValues, type: VehicleTypeDto) => {
    // isLinear is deliberately absent from the PATCH body: that endpoint answers 422 on the flag
    // (ADR 0107 §5), which only the dedicated switch endpoint may change.
    const body: UpdateVehicleTypeInput = {
      name: values.name,
      description: values.description ?? '',
      sortOrder: values.sortOrder,
      isActive: values.isActive,
      waybillFormCode: typeWaybillFormOf(values.isPassenger ?? false),
      // Maintenance marking is an ordinary field: it has no protocol of its own because it enables
      // a calculation rather than rewriting the mode of running requests.
      maintenanceBasis: maintenanceBasisOf(values.maintenanceByOdometer ?? false),
    };
    const nextLinear = values.isLinear ?? false;
    setSaving(true);
    let switched = false;
    try {
      if (nextLinear !== type.isLinear) {
        const result = await runLinearSwitch(type, nextLinear);
        if (!result) return;
        switched = true;
        // Align the form's type with the directory at once: retrying the save after a failed
        // PATCH must not call the switch a second time.
        setRecord(result.type);
        if (result.frozenNow > 0) {
          // Numbers come from the write response, not from the preview shown earlier: the set
          // could have changed in between, and frozen are exactly those the write returned
          // (ADR 0107 §8). The long list is cut: the counter stays complete, nobody reads forty
          // numbers in a toast, and they are kept in the action log.
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
      // A database change nobody asked for: the checkbox was about the blank, yet trailers were
      // unhitched from every vehicle of the type. Hence a warning, shown longer than usual, as in
      // the vehicle registry; on zero — silence.
      if (saved.unhitchedTrailers)
        message.warning(unhitchedNotice(saved.unhitchedTrailers, saved.unhitchedVehicles), 8);
      // Moving a type onto the «форма № 3» blank strips the hitches of EVERY vehicle of that type
      // (releaseHitchesOfVehicleType on the server) — trailer rows live under their own root,
      // missed by invalidateTypes, so freed trailers would keep showing a tractor whose blank
      // cannot print them. Here and not in finally: the release rides in the PATCH, and a failed
      // PATCH unhitches nothing.
      void queryClient.invalidateQueries({ queryKey: trailerKeys.root });
      setOpen(false);
    } catch (error) {
      // The switch went through but the other fields did not: «not saved» would be false here.
      // The form stays open with the unsaved fields while the checkbox already matches the
      // directory — pressing save again writes what did not arrive, and no second switch happens.
      message.error(
        switched
          ? `Режим переключён, остальные поля не сохранены: ${errorMessage(error)}. Повторите сохранение.`
          : errorMessage(error),
      );
    } finally {
      // The type is re-read in every outcome: after a switch it is different even if the PATCH
      // failed, and an extra request is cheaper than a form arguing with the directory.
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
