import { useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateOfficeEquipmentTypeInput, OfficeEquipmentTypeDto } from '@technic/contracts';
import { FormModal, useFormBlockers } from '@shared/ui';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import {
  officeEquipmentKeys,
  officeEquipmentTypeKeys,
  officeEquipmentTypesApi,
} from '@entities/office-equipment';
import { errorMessage } from '../../utils/format';

/**
 * Ведение типов оргтехники — окном из вкладки справочника (Р34, приём ADR 0017).
 *
 * Отдельной вкладки у перечня нет намеренно: сам по себе тип ничего не значит — он существует
 * только затем, чтобы им назвали единицу, — и десяток строк не стоит вкладки, между которой и
 * справочником пришлось бы ходить туда-обратно при каждом заведении новой техники.
 *
 * Список запрашивается целиком и без фильтров: он маленький, и выключенные типы здесь нужны не
 * меньше активных — их тут как раз и включают обратно.
 */

/** Перечень целиком: порядок задан руками, алфавит поставил бы «Прочее» посреди списка. */
const LIST_PARAMS = {
  page: 1,
  pageSize: DICTIONARY_PAGE_SIZE,
  sortBy: 'sortOrder',
  sortOrder: 'asc' as const,
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function OfficeEquipmentTypesModal({ open, onClose }: Props) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentTypeKeys.list(LIST_PARAMS),
    queryFn: () => officeEquipmentTypesApi.list(LIST_PARAMS),
    // Перечень нужен только пока окно открыто: ради кнопки в шапке вкладки его не запрашивают.
    enabled: open,
  });
  const types = data?.items ?? [];

  const [formOpen, setFormOpen] = useState(false);
  const [record, setRecord] = useState<OfficeEquipmentTypeDto | null>(null);
  const [form] = Form.useForm<CreateOfficeEquipmentTypeInput>();
  const blockers = useFormBlockers(form);

  /**
   * Список типов устарел после любой правки, и вместе с ним — список единиц: тип стоит в его
   * колонке своим названием, и переименование обязано доехать до строк справочника.
   */
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: officeEquipmentTypeKeys.root });
    void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
  };

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    form.setFieldsValue({ sortOrder: 100, isActive: true } as CreateOfficeEquipmentTypeInput);
    setFormOpen(true);
  };

  const openEdit = (t: OfficeEquipmentTypeDto) => {
    setRecord(t);
    form.resetFields();
    form.setFieldsValue({
      code: t.code,
      name: t.name,
      sortOrder: t.sortOrder,
      isActive: t.isActive,
    });
    setFormOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: CreateOfficeEquipmentTypeInput) =>
      record
        ? officeEquipmentTypesApi.update(record.id, values)
        : officeEquipmentTypesApi.create(values),
    onSuccess: () => {
      message.success('Сохранено');
      invalidate();
      setFormOpen(false);
    },
    // Занятый код сервер называет полем — показываем его у поля, а не тостом поверх формы.
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => officeEquipmentTypesApi.remove(id),
    onSuccess: () => {
      message.success('Тип удалён');
      invalidate();
    },
    // Отказ «тип используется в карточках» — обычный ответ, а не сбой: он и объясняет, почему
    // строку не удалить, и подсказывает, что делать вместо этого.
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmDelete = (t: OfficeEquipmentTypeDto) =>
    modal.confirm({
      title: `Удалить тип «${t.name}»?`,
      content:
        'Запись удаляется насовсем. Тип, которым уже названа техника, удалить нельзя — чтобы на него перестали заводить новые карточки, снимите «Активен».',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(t.id),
    });

  return (
    <>
      <Modal
        title="Типы оргтехники"
        open={open}
        onCancel={onClose}
        width={560}
        centered
        mask={{ closable: false }}
        footer={<Button onClick={onClose}>Закрыть</Button>}
        styles={{ body: { maxHeight: '60dvh', overflowY: 'auto' } }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            Чем называют технику в списке и в заявке: МФУ, принтер, ноутбук, монитор. Порядок задаёт
            место типа в выпадающих списках.
          </Typography.Text>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Добавить тип
          </Button>
          <List
            size="small"
            loading={isFetching}
            dataSource={types}
            locale={{ emptyText: 'Типов пока нет' }}
            renderItem={(t) => (
              <List.Item
                actions={[
                  <Button
                    key="edit"
                    size="small"
                    icon={<EditOutlined />}
                    aria-label="Редактировать"
                    onClick={() => openEdit(t)}
                  />,
                  <Button
                    key="delete"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label="Удалить"
                    onClick={() => confirmDelete(t)}
                  />,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space size={8}>
                      {t.name}
                      {/* Выключенный тип остаётся у заведённых карточек — строка обязана
                          объяснить, почему его не предлагают в форме. */}
                      {!t.isActive && <Tag>Не используется</Tag>}
                    </Space>
                  }
                  description={`${t.code} · порядок ${t.sortOrder}`}
                />
              </List.Item>
            )}
          />
        </Space>
      </Modal>

      <FormModal
        title={record ? 'Редактирование типа' : 'Новый тип'}
        open={formOpen}
        onCancel={() => setFormOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={440}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)} {...blockers.formProps}>
          <Form.Item
            name="code"
            label="Код"
            rules={[{ required: true, message: 'Укажите код' }]}
            // Код правится: перечень наполняют руками, и опечатку исправляют, а не заводят
            // второй тип рядом.
            extra="Латиница, цифры и подчёркивание: mfp, printer, laptop"
          >
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item
            name="name"
            label="Название"
            rules={[{ required: true, message: 'Укажите название типа' }]}
          >
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item
            name="sortOrder"
            label="Порядок"
            tooltip="Чем меньше число, тем выше тип в выпадающих списках"
          >
            <InputNumber style={{ width: '100%' }} min={0} max={9999} />
          </Form.Item>
          <Form.Item
            name="isActive"
            label="Активен"
            valuePropName="checked"
            extra="Неактивный тип исчезает из выбора в форме; заведённые карточки остаются как есть"
          >
            <Switch />
          </Form.Item>
        </Form>
      </FormModal>
    </>
  );
}
