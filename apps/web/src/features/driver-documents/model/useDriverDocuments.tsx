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

/**
 * Own document replacement, verification, revocation and correction commands. The presentation of
 * the documents themselves lives in the driver entity (documentsBlock and the column helpers); this
 * feature owns the requests and the dialogs behind them.
 */
export function useDriverDocuments({ canWrite, canDelete }: Options): DriverDocumentsController {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [record, setRecord] = useState<DriverDto | null>(null);
  // The credential kind is state next to the form, not a form field: the modal opens with the kind
  // derived from the job title while the form is not mounted yet, and a value put into an unmounted
  // antd form before its first render is lost. Changing the kind also clears the chosen categories
  // (see onCredentialTypeChange below).
  const [credentialType, setCredentialType] = useState<CredentialTypeCode>('driver_license');
  const [form] = Form.useForm<DriverLicenseFormValues>();
  // Server refusals for the document mark the field instead of a toast (ADR 0094). Introduced for a
  // taken number: it answers validation_error with field «number», and the hint belongs where the
  // value is edited — otherwise the user searches the dialog for what the portal already knows.
  const blockers = useFormBlockers(form);
  const categoryOptions = useLicenseCategoryOptions(credentialType);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: driverKeys.root });
    void queryClient.invalidateQueries({ queryKey: garageKeys.root });
  };

  // The kind defaults from the job title: an excavator operator gets a tractor credential nine
  // times out of ten. The choice stays open because a truck-crane operator holds a driver license in the
  // HR data, and not every job title is known to the mapping (ADR 0095).
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

  // Removing a document from the card is not revocation: revocation says «the document existed and
  // stopped being valid», removal says «it should not be here» (a typo in the number, a foreign
  // import row, a duplicate of the same credential). It also frees the series and number: while the
  // stray document stays in the card, the real one with the same number cannot be created at all.
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
    // The document is addressed by id, not as «the driver's current one»: a person holds two kinds,
    // and «current» without a kind would put the verification mark on the wrong paper.
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
          // Chosen categories are dictionary records of the previous kind: the new document has no
          // such records, and they would reach the server as a refusal instead of a new credential.
          form.setFieldValue('categoryIds', []);
        }}
      />
    ),
  };
}
