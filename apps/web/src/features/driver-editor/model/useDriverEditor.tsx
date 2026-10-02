import { useState, type ReactNode } from 'react';
import { App, Form } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatSnils, type DriverDto } from '@technic/contracts';
import {
  driverErrorMessage as errorMessage,
  driverKeys,
  driversApi,
  type DriverDocumentActions,
  useLicenseCategoryOptions,
} from '@entities/driver';
import { garageKeys } from '@entities/garage';
import { userAccountKeys } from '@entities/user-account';
import { DriverEditorModal } from '../ui/DriverEditorModal';
import type { DriverFormValues } from './types';

const DATE = 'YYYY-MM-DD';

interface Options {
  documentActions: DriverDocumentActions;
}

export interface DriverEditorController {
  actions: {
    create: () => void;
    edit: (record: DriverDto) => void;
  };
  node: ReactNode;
}

/** Own the driver card form and the create/update command. */
export function useDriverEditor({ documentActions }: Options): DriverEditorController {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<DriverDto | null>(null);
  const [form] = Form.useForm<DriverFormValues>();
  const driverLicenseOptions = useLicenseCategoryOptions('driver_license');

  const create = () => {
    setRecord(null);
    form.resetFields();
    setOpen(true);
  };

  const edit = (driver: DriverDto) => {
    setRecord(driver);
    form.resetFields();
    form.setFieldsValue({
      lastName: driver.lastName,
      firstName: driver.firstName,
      middleName: driver.middleName,
      snils: formatSnils(driver.snils),
      phone: driver.phone,
      email: driver.email,
      personnelNo: driver.personnelNo,
      comment: driver.comment,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (values: DriverFormValues) => {
      const base = {
        lastName: values.lastName,
        firstName: values.firstName,
        middleName: values.middleName ?? '',
        snils: values.snils,
        phone: values.phone ?? '',
        email: values.email ?? '',
        personnelNo: values.personnelNo ?? '',
        comment: values.comment ?? '',
      };
      if (record) return driversApi.update(record.id, { ...base, version: record.version });
      return driversApi.create({
        ...base,
        ...(values.license
          ? {
              license: {
                series: values.license.series ?? '',
                number: values.license.number,
                issuedOn: values.license.issuedOn?.format(DATE) ?? null,
                expiresOn: values.license.expiresOn?.format(DATE) ?? null,
                categories: (values.license.categoryIds ?? []).map((categoryId) => ({
                  categoryId,
                })),
              },
            }
          : {}),
      });
    },
    onSuccess: () => {
      message.success('Сохранено');
      void queryClient.invalidateQueries({ queryKey: driverKeys.root });
      void queryClient.invalidateQueries({ queryKey: garageKeys.root });
      // Driver identity is copied into a linked account, which has its own cache root.
      void queryClient.invalidateQueries({ queryKey: userAccountKeys.root });
      setOpen(false);
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const editorDocumentActions: DriverDocumentActions = {
    ...documentActions,
    onReplace: (driver, type) => {
      // The replacement modal takes over; keeping both modals open traps focus in the card.
      setOpen(false);
      documentActions.onReplace(driver, type);
    },
  };

  return {
    actions: { create, edit },
    node: (
      <DriverEditorModal
        open={open}
        record={record}
        form={form}
        documentActions={editorDocumentActions}
        driverLicenseOptions={driverLicenseOptions}
        pending={save.isPending}
        onCancel={() => setOpen(false)}
        onSubmit={(values) => save.mutate(values)}
      />
    ),
  };
}
