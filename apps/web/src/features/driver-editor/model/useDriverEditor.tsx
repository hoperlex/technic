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

/**
 * Own the driver card form and the create/update command (ADR 0037, ADR 0095).
 *
 * A new card is created together with its driver license: a driver without a document is not
 * offered when a request is moved into work and silently disappears from that form, so the document
 * is asked for right away rather than «some day later».
 */
export function useDriverEditor({ documentActions }: Options): DriverEditorController {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<DriverDto | null>(null);
  const [form] = Form.useForm<DriverFormValues>();
  // The create form asks only for a driver license: the job title is not chosen here, and a new
  // person is created as a driver (createDriverSchema). A tractor credential is added as a second
  // step through the «Новое удостоверение» dialog, where the kind is asked explicitly.
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
      // The card owns the name and the phone, so the server copies both into the live account of
      // the same person — under its own cache root, not covered by driverKeys.root. Without this
      // the «Пользователи» tab and every account picker keep the old name. Of the directory's doors
      // only this one writes to users: purging refuses while a live account points at the person.
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
