import { useState, type ReactNode } from 'react';
import { App, Form } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CreateVehicleInput,
  type UpdateVehicleInput,
  type UpdateVehicleResult,
  type VehicleDto,
  type VehicleOwnership,
  parseVehicleClassificationKey,
  rentalActivationBlockReason,
} from '@technic/contracts';
import { counterpartyActiveVehicleLessorsQuery } from '@entities/counterparty';
import { garageKeys } from '@entities/garage';
import {
  vehicleErrorMessage as errorMessage,
  vehicleKeys,
  vehicleModelKeys,
  vehicleModelsApi,
  vehiclesApi,
} from '@entities/vehicle';
import {
  classificationKeyOf,
  useVehicleClassifications,
  withSavedClassification,
} from '@entities/vehicle-type';
import { trailerKeys, unhitchedNotice } from '@entities/vehicle-trailer';
import { VehicleEditorModal, type VehicleFormValues } from '../ui/VehicleEditorModal';

/**
 * Create returns a bare card rather than the update result. A new vehicle cannot have released
 * any hitches, so zero is a fact of creation, not a placeholder for an unreported side effect.
 */
const created = (vehicle: VehicleDto): UpdateVehicleResult => ({ vehicle, unhitchedTrailers: 0 });

export interface VehicleEditorController {
  actions: {
    create: (preferredOwnership?: VehicleOwnership) => void;
    edit: (record: VehicleDto) => void;
  };
  node: ReactNode;
}

export function useVehicleEditor(): VehicleEditorController {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleDto | null>(null);
  const [form] = Form.useForm<VehicleFormValues>();
  const ownership = Form.useWatch('ownership', form) ?? 'own';
  // The form selects one classification position, while models are loaded by its owning type.
  const classificationKey = Form.useWatch('classificationKey', form);
  const watchTypeId = parseVehicleClassificationKey(classificationKey)?.vehicleTypeId;
  const isRental = ownership === 'rental';

  const { groups: classificationGroups, loading: classificationsLoading } =
    useVehicleClassifications();
  const { data: lessorsData, isLoading: lessorsLoading } = useQuery(
    counterpartyActiveVehicleLessorsQuery(),
  );
  const activeLessorOptions = (lessorsData?.items ?? []).map((lessor) => ({
    value: lessor.id,
    label: lessor.name,
  }));
  // Preserve an inactive saved lessor as a readable disabled-era choice instead of showing a uuid.
  const lessorOptions =
    record?.lessorId && !activeLessorOptions.some((option) => option.value === record.lessorId)
      ? [
          ...activeLessorOptions,
          { value: record.lessorId, label: `${record.lessorName ?? '—'} (неактивен)` },
        ]
      : activeLessorOptions;

  const { data: modelsData } = useQuery({
    queryKey: vehicleModelKeys.forSelect(watchTypeId),
    queryFn: () =>
      vehicleModelsApi.list({
        page: 1,
        pageSize: 500,
        vehicleTypeId: watchTypeId,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled: !!watchTypeId && !isRental,
  });
  // An unseeded type legitimately has no model options; model selection is optional (ADR 0007).
  const modelOptions = (modelsData?.items ?? []).map((model) => ({
    value: model.id,
    label: model.name,
  }));

  // A saved position may since have been disabled, or predate categories. Keep it visible as a
  // disabled option so the card never looks as if its classification was lost.
  const classificationOptions = withSavedClassification(
    classificationGroups,
    record
      ? {
          vehicleTypeId: record.vehicleTypeId,
          vehicleCategoryId: record.vehicleCategoryId,
          typeName: record.typeName,
          categoryName: record.categoryName,
        }
      : null,
  );

  const create = (preferredOwnership: VehicleOwnership = 'own') => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ ownership: preferredOwnership, status: 'active' });
    setOpen(true);
  };

  const edit = (next: VehicleDto) => {
    setRecord(next);
    form.resetFields();
    form.setFieldsValue({
      ownership: next.ownership,
      classificationKey: classificationKeyOf(next),
      vehicleModelId: next.vehicleModelId ?? undefined,
      registrationNumber: next.registrationNumber ?? undefined,
      passportNumber: next.passportNumber ?? undefined,
      lessorId: next.lessorId ?? undefined,
      description: next.description || undefined,
      pricePerHour: next.pricePerHour ?? undefined,
      pricePerShift: next.pricePerShift ?? undefined,
      shiftHours: next.shiftHours ?? undefined,
      status: next.status,
      note: next.note,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: async (values: VehicleFormValues): Promise<UpdateVehicleResult> => {
      // One classification selection becomes the API's type/category pair (ADR 0028).
      const chosen = parseVehicleClassificationKey(values.classificationKey)!;
      const common = {
        vehicleTypeId: chosen.vehicleTypeId,
        vehicleCategoryId: chosen.vehicleCategoryId,
        status: values.status,
        note: values.note ?? '',
      };
      if (values.ownership === 'rental') {
        const body = {
          ...common,
          lessorId: values.lessorId!,
          description: values.description ?? '',
          pricePerHour: values.pricePerHour ?? null,
          pricePerShift: values.pricePerShift ?? null,
          shiftHours: values.shiftHours ?? null,
        };
        // Ownership is immutable, so PATCH never sends it.
        return record
          ? vehiclesApi.update(record.id, body as UpdateVehicleInput)
          : created(
              await vehiclesApi.create({ ownership: 'rental', ...body } as CreateVehicleInput),
            );
      }
      const body = {
        ...common,
        vehicleModelId: values.vehicleModelId ?? null,
        registrationNumber: values.registrationNumber ?? null,
        passportNumber: values.passportNumber ?? null,
      };
      return record
        ? vehiclesApi.update(record.id, body as UpdateVehicleInput)
        : created(await vehiclesApi.create({ ownership: 'own', ...body } as CreateVehicleInput));
    },
    onSuccess: ({ unhitchedTrailers }) => {
      message.success('Сохранено');
      // Retiring a vehicle or moving it to form No. 3 releases hitches as a server-side effect.
      // Call that out separately; zero remains silent because no hidden change occurred.
      if (unhitchedTrailers) {
        message.warning(unhitchedNotice(unhitchedTrailers, 'этой правкой'), 8);
      }
      void queryClient.invalidateQueries({ queryKey: vehicleKeys.root });
      // The trailer registry has its own root and embeds the tractor in each row (hitchedVehicle).
      // This edit can both change that embedded card and release its hitches on the server
      // (releaseHitchesOfVehicle, on retirement or a move to form No. 3). Dropping only
      // vehicleKeys.root would leave the registry and the card's trailer slots showing an old
      // tractor or a hitch the server has already released.
      void queryClient.invalidateQueries({ queryKey: trailerKeys.root });
      void queryClient.invalidateQueries({ queryKey: garageKeys.root });
      setOpen(false);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  return {
    actions: { create, edit },
    node: (
      <VehicleEditorModal
        open={open}
        record={record}
        form={form}
        isRental={isRental}
        watchTypeId={watchTypeId}
        blockReason={record ? rentalActivationBlockReason(record) : null}
        classificationOptions={classificationOptions}
        classificationsLoading={classificationsLoading}
        lessorOptions={lessorOptions}
        lessorsLoading={lessorsLoading}
        modelOptions={modelOptions}
        pending={save.isPending}
        onCancel={() => setOpen(false)}
        onSubmit={(values) => save.mutate(values)}
      />
    ),
  };
}
