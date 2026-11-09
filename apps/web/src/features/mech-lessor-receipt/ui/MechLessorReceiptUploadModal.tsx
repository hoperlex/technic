import { useEffect, useEffectEvent, useRef } from 'react';
import { Alert, App, Button, Form, type FormRule } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import {
  isMechLessorReceiptContentType,
  MECH_LESSOR_RECEIPT_ACCEPT,
  MECH_LESSOR_RECEIPT_CONTENT_TYPE_MESSAGE,
} from '@technic/contracts';
import { mechFailureText } from '@entities/mech-request';
import { FILE_MAX_SIZE } from '@shared/config';
import { FormModal, useFormBlockers } from '@shared/ui';
import { useAttachMechLessorReceipt, type MechLessorReceiptRental } from '../model/mutations';

interface Values {
  file?: File;
}

/**
 * The rules sit on the field, so a wrong file is named under it and stays chosen with its reason.
 * The type is the one the browser declares — the server compares exactly that (P7) — so a file the
 * server would refuse is refused here first, with the same words.
 */
const fileRule: FormRule = {
  validator: async (_rule, file?: File) => {
    if (!file) throw new Error('Выберите файл чека');
    if (!isMechLessorReceiptContentType(file.type)) {
      throw new Error(MECH_LESSOR_RECEIPT_CONTENT_TYPE_MESSAGE);
    }
    if (file.size > FILE_MAX_SIZE) throw new Error('Файл больше 50 МБ');
  },
};

/**
 * «Прикрепить чек» / «Заменить чек» (lessor receipt plan, P7): ONE file, PDF or JPG (O4). The file
 * goes to storage first and is attached second, as every attachment of the portal.
 *
 * Shared by the office's card and the lessor's page (W4): it asks only the rental's id, number and
 * version, and the attach door is the same for both — the server decides by the account what a
 * replace may touch (O13).
 *
 * A replacement says what it does to a decision: the new version waits for the visa again, whatever
 * the old one was.
 */
export function MechLessorReceiptUploadModal({
  rental,
  replace,
  onClose,
}: {
  /** `null` — closed. */
  rental: MechLessorReceiptRental | null;
  /** A current version exists: the window replaces it. */
  replace: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const attach = useAttachMechLessorReceipt();

  // Emptied once per opening: a reread of the card under the window must not drop the chosen file.
  const rentalId = rental?.id ?? null;
  const reset = useEffectEvent((_rentalId: string | null) => {
    if (rental) form.resetFields();
  });
  useEffect(() => reset(rentalId), [rentalId]);

  const submit = ({ file }: Values) => {
    if (!rental || !file) return;
    attach.mutate(
      { rental, file },
      {
        onSuccess: () => {
          message.success(replace ? 'Чек заменён — он снова ждёт визы' : 'Чек прикреплён');
          onClose();
        },
        onError: (e) => {
          if (!blockers.fromApi(e)) message.error(mechFailureText(e));
        },
      },
    );
  };

  return (
    <FormModal
      title={
        rental
          ? `${replace ? 'Заменить' : 'Прикрепить'} чек арендодателя · ${rental.displayNumber}`
          : 'Чек арендодателя'
      }
      open={!!rental}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={attach.isPending}
      okText={replace ? 'Заменить' : 'Прикрепить'}
      width={460}
    >
      {replace && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="Новая версия заменит текущую и будет ждать визы заново"
          description="Прежняя версия останется в «Версиях чека» и в истории заявки."
        />
      )}
      <Form
        form={form}
        layout="vertical"
        disabled={attach.isPending}
        onFinish={submit}
        {...blockers.formProps}
      >
        <Form.Item
          name="file"
          label="Файл чека"
          extra="Один файл: PDF или JPG — скан или фото чека"
          rules={[fileRule]}
        >
          <ReceiptFileField />
        </Form.Item>
      </Form>
    </FormModal>
  );
}

/**
 * The file as a form control: `Form.Item` hands it `value`, `onChange` and `id`. The real input is
 * out of sight and opened by the button, which shows the chosen name.
 *
 * Hidden by an inline `display: none`, not the `hidden` attribute: antd's form stylesheet gives
 * `input[type="file"]` a `display: block` that beats the attribute, and the browser's own empty
 * «No file chosen» would show above the button. `accept` comes from the contracts — iOS Safari
 * converts a library photo to JPEG under it, so an iPhone's HEIC arrives as JPG.
 */
function ReceiptFileField({
  id,
  value,
  onChange,
}: {
  id?: string;
  value?: File;
  onChange?: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div id={id} style={{ minWidth: 0 }}>
      <input
        ref={input}
        type="file"
        accept={MECH_LESSOR_RECEIPT_ACCEPT}
        style={{ display: 'none' }}
        aria-label="Файл чека"
        onChange={(event) => {
          const picked = event.target.files?.[0];
          // Cleared so the same file can be chosen again after the window was reset.
          event.target.value = '';
          if (picked) onChange?.(picked);
        }}
      />
      <Button
        block
        icon={<UploadOutlined />}
        title={value?.name}
        style={{ justifyContent: 'flex-start' }}
        onClick={() => input.current?.click()}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {value ? value.name : 'Выбрать файл'}
        </span>
      </Button>
    </div>
  );
}
