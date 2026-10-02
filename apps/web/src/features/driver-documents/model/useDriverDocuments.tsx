import { useState, type ReactNode } from 'react';
import { App, Form, Input } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type CredentialTypeCode,
  credentialTypeShortLabels,
  type DriverDto,
  type DriverLicenseDto,
  licenseNumberLabel,
  requiredCredentialType,
} from '@technic/contracts';
import {
  driverErrorMessage as errorMessage,
  driverKeys,
  driversApi,
  type DriverDocumentActions,
  useLicenseCategoryOptions,
} from '@entities/driver';
import { garageKeys } from '@entities/garage';
import { useFormBlockers } from '@shared/ui';
import { DriverLicenseModal } from '../ui/DriverLicenseModal';
import type { DriverLicenseFormValues } from './types';

const DATE = 'YYYY-MM-DD';

interface Options {
  canWrite: boolean;
  canDelete: boolean;
}

export interface DriverDocumentsController {
  actions: DriverDocumentActions;
  open: (record: DriverDto, type?: CredentialTypeCode) => void;
  node: ReactNode;
}

/** Own document replacement, verification, revocation and correction commands. */
export function useDriverDocuments({ canWrite, canDelete }: Options): DriverDocumentsController {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [record, setRecord] = useState<DriverDto | null>(null);
  const [credentialType, setCredentialType] = useState<CredentialTypeCode>('driver_license');
  const [form] = Form.useForm<DriverLicenseFormValues>();
  const blockers = useFormBlockers(form);
  const categoryOptions = useLicenseCategoryOptions(credentialType);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: driverKeys.root });
    void queryClient.invalidateQueries({ queryKey: garageKeys.root });
  };

  const open = (driver: DriverDto, type = requiredCredentialType(driver.jobTitle)) => {
    setRecord(driver);
    setCredentialType(type);
    form.resetFields();
  };

  const add = useMutation({
    mutationFn: (values: DriverLicenseFormValues) =>
      driversApi.addLicense(record!.id, {
        credentialType,
        series: values.series ?? '',
        number: values.number,
        issuedOn: values.issuedOn?.format(DATE) ?? null,
        expiresOn: values.expiresOn?.format(DATE) ?? null,
        categories: (values.categoryIds ?? []).map((categoryId) => ({ categoryId })),
        deletePrevious: values.deletePrevious ?? false,
      }),
    onSuccess: () => {
      message.success('Удостоверение добавлено');
      invalidate();
      setRecord(null);
    },
    onError: (error) => {
      if (!blockers.fromApi(error)) message.error(errorMessage(error));
    },
  });

  const remove = useMutation({
    mutationFn: ({ driver, license }: { driver: DriverDto; license: DriverLicenseDto }) =>
      driversApi.deleteLicense(driver.id, license.id),
    onSuccess: () => {
      message.success('Документ убран из карточки');
      invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const verify = useMutation({
    // A credential id is mandatory: one person can have two kinds and several historical records.
    mutationFn: ({
      driver,
      license,
      status,
    }: {
      driver: DriverDto;
      license: DriverLicenseDto;
      status: 'verified' | 'rejected';
    }) => driversApi.verifyLicense(driver.id, license.id, { verificationStatus: status }),
    onSuccess: () => {
      message.success('Отметка проверки сохранена');
      invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const revoke = useMutation({
    mutationFn: ({
      driver,
      license,
      reason,
    }: {
      driver: DriverDto;
      license: DriverLicenseDto;
      reason: string;
    }) => driversApi.revokeLicense(driver.id, license.id, { revokeReason: reason }),
    onSuccess: () => {
      message.success('Удостоверение аннулировано');
      invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const requestRemove = (driver: DriverDto, license: DriverLicenseDto) =>
    modal.confirm({
      title: `Убрать ${credentialTypeShortLabels[license.credentialTypeCode]} ${licenseNumberLabel(license)}?`,
      content:
        'Документ пропадёт из карточки и из отбора, а выданные по нему путевые листы сохранятся. ' +
        'Восстановить его из портала нельзя — заводить придётся заново.',
      okText: 'Убрать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => remove.mutateAsync({ driver, license }),
    });

  const requestRevoke = (driver: DriverDto, license: DriverLicenseDto) => {
    let reason = '';
    modal.confirm({
      title: `Аннулировать ${credentialTypeShortLabels[license.credentialTypeCode]}?`,
      content: (
        <Input.TextArea
          rows={2}
          placeholder="Причина: лишение права управления, утрата документа…"
          onChange={(event) => {
            reason = event.target.value;
          }}
        />
      ),
      okText: 'Аннулировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.error('Укажите причину');
          throw new Error('reason required');
        }
        await revoke.mutateAsync({ driver, license, reason });
      },
    });
  };

  const actions: DriverDocumentActions = {
    canWrite,
    onReplace: open,
    onVerify: (driver, license, status) => verify.mutate({ driver, license, status }),
    onRevoke: requestRevoke,
    canDelete,
    onDelete: requestRemove,
  };

  return {
    actions,
    open,
    node: (
      <DriverLicenseModal
        record={record}
        form={form}
        blockers={blockers}
        credentialType={credentialType}
        categoryOptions={categoryOptions}
        canDelete={canDelete}
        pending={add.isPending}
        onCancel={() => setRecord(null)}
        onSubmit={(values) => add.mutate(values)}
        onCredentialTypeChange={(nextType) => {
          setCredentialType(nextType);
          // Category ids belong to one credential dictionary and cannot cross the type boundary.
          form.setFieldValue('categoryIds', []);
        }}
      />
    ),
  };
}
