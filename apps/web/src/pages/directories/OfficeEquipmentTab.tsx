import { useState } from 'react';
import { App, Button, Form, Space } from 'antd';
import { AppstoreOutlined, PlusOutlined, PrinterOutlined, TagsOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type OfficeEquipmentDto, officeEquipmentTitle } from '@technic/contracts';
import { DataTable } from '@shared/ui';
import { FormModal, useFormBlockers } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import {
  OfficeEquipmentFields,
  type OfficeEquipmentFormValues,
  officeEquipmentApi,
  officeEquipmentPayload,
  officeEquipmentUpdatePayload,
  officeEquipmentConsumableKeys,
  officeEquipmentKeys,
  officeEquipmentModelKeys,
  officeEquipmentTypeOptionsQuery,
  officeEquipmentCard,
  officeEquipmentColumns,
  OfficeEquipmentSpecsView,
} from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import {
  useOfficeEquipmentFilters,
  type OfficeEquipmentFilterParams,
} from './OfficeEquipmentFilters';
import { OfficeEquipmentTypesModal } from './OfficeEquipmentTypesModal';
import { OfficeEquipmentModelsModal } from './OfficeEquipmentModelsModal';
import { OfficeEquipmentConsumablesModal } from './OfficeEquipmentConsumablesModal';
import { OfficeEquipmentServiceHistory } from './OfficeEquipmentServiceHistory';
import { OfficeEquipmentSupplies } from './OfficeEquipmentSupplies';
import { EquipmentMoveModal } from '@features/equipment-move';
import { EquipmentHistoryModal } from '@features/equipment-history';

/**
 * Справочник оргтехники (ADR 0085): что стоит по кабинетам и площадкам, за каким отделом
 * закреплено и до какого числа действует гарантия поставщика.
 *
 * Вкладка живёт в «Справочниках», а не в разделе заявок на обслуживание (Р7): её ведёт тот же
 * человек, который заводит объекты и контрагентов, а сервису справочник закрыт вовсе — реквизиты
 * нужной ему единицы приходят снимком в самой заявке.
 *
 * Гарантия показана тегом состояния, а не датой (§9.6): справочник открывают с вопросом «что
 * продлевать», и ответ на него — не число, а цвет. Считает состояние общая функция контрактов —
 * подсветка обязана совпадать со списком заявок и реестром гарантий.
 */

export function OfficeEquipmentTab() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const canWrite = can('officeEquipment.write');
  const qc = useQueryClient();

  // Набор отборов описан один раз — в модуле полосы фильтров: разъехавшись, тип параметров и
  // сама полоса начали бы спорить о том, что вкладка умеет спрашивать.
  const { params, setParams, setSort, onTableChange } = useListParams<OfficeEquipmentFilterParams>(
    {},
    {
      // Поиск живёт лупой в заголовке «Модели» — единственного столбца с поисковой выпадашкой;
      // сервер ищет по нему же и по обоим номерам.
      searchKeys: ['name'],
      mapFilters: (f) => ({ isActive: f.isActive?.[0] as string | undefined }),
    },
  );

  const { data, isFetching } = useQuery({
    queryKey: officeEquipmentKeys.list(params),
    queryFn: () => officeEquipmentApi.list(params),
  });

  const { data: typeOptions = [], isLoading: typesLoading } = useQuery(
    officeEquipmentTypeOptionsQuery(),
  );
  // Закрытые площадки из списка не убираем: техника на них заведена, и в форме правки привязка
  // осталась бы без наименования — та же оговорка, что у складов приостановленного поставщика.
  const { data: objectOptions = [] } = useQuery(objectOptionsQuery({ activeOnly: false }));
  const { data: departmentOptions = [] } = useQuery(departmentOptionsQuery());

  const [typesOpen, setTypesOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [consumablesOpen, setConsumablesOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<OfficeEquipmentDto | null>(null);
  const [form] = Form.useForm<OfficeEquipmentFormValues>();
  const blockers = useFormBlockers(form);

  /** Смена любого отбора возвращает список на первую страницу: та же страница — уже другие строки. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    // Фильтры площадки и типа — они же ответ на «что заводим»: справочник наполняют кабинет за
    // кабинетом, а не вперемешку.
    form.setFieldsValue({
      isActive: true,
      objectId: params.objectId,
      equipmentTypeId: params.equipmentTypeId,
    } as OfficeEquipmentFormValues);
    setOpen(true);
  };

  const openEdit = (r: OfficeEquipmentDto) => {
    setRecord(r);
    form.resetFields();
    form.setFieldsValue({
      equipmentTypeId: r.type.id,
      // Ссылка, а не имя: с выпуска A `name` карточки — зеркало имени модели, которое ведёт база
      // (Р3), и подставлять его в поле означало бы предложить править зеркало.
      modelId: r.model?.id,
      serialNumber: r.serialNumber,
      inventoryNumber: r.inventoryNumber,
      objectId: r.object.id,
      departmentId: r.department?.id,
      location: r.location,
      // Календарный день без времени: `dayjs('2026-08-07')` разбирается в полночь по месту, и
      // обратный `format` возвращает ровно тот же день — пересчёта поясов здесь быть не должно.
      purchasedOn: r.purchasedOn ? dayjs(r.purchasedOn) : undefined,
      warrantyUntil: r.warrantyUntil ? dayjs(r.warrantyUntil) : undefined,
      comment: r.comment,
      isActive: r.isActive,
    });
    setOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: (values: OfficeEquipmentFormValues) =>
      record
        ? officeEquipmentApi.update(record.id, officeEquipmentUpdatePayload(values))
        : officeEquipmentApi.create(officeEquipmentPayload(values)),
    onSuccess: () => {
      message.success('Сохранено');
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      /*
       * Матрица Р14, вторая сторона: счётчик «В парке» в окне моделей посчитан по карточкам, и
       * его меняет каждое из действий этой формы — заведение, смена модели, снятая «Активна»,
       * смена отдела-владельца. Без гашения окно, открытое следом, показывало бы вчерашнее число
       * ровно `staleTime`, то есть первые десять секунд после правки.
       */
      void qc.invalidateQueries({ queryKey: officeEquipmentModelKeys.root });
      // Та же матрица и тот же счётчик, но во втором окне: «В парке» в списке и карточке
      // расходника посчитан по карточкам техники в области смотрящего (Р12, Р15).
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      setOpen(false);
    },
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => officeEquipmentApi.remove(id),
    onSuccess: () => {
      message.success('Карточка удалена');
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      // Уехавшая в архив карточка выпадает из счётчика «В парке» (Р12): он считает живые и
      // активные — значит устарел и он (Р14). Счётчиков этих два, в обоих окнах.
      void qc.invalidateQueries({ queryKey: officeEquipmentModelKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
    },
    // «По технике есть незакрытые заявки» — обычный ответ сервера, а не сбой: он и объясняет,
    // почему карточку не убрать.
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmDelete = (r: OfficeEquipmentDto) =>
    modal.confirm({
      title: `Удалить «${officeEquipmentTitle(r)}»?`,
      content:
        'Карточка уходит в архив: заявки на обслуживание по этой технике остаются на месте. Чтобы просто убрать её из выбора, снимите «Активна».',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(r.id),
    });

  /** Что открыто в окне перемещения и в ленте истории; `null` — окно закрыто (Р59, Р62). */
  const [moving, setMoving] = useState<OfficeEquipmentDto | null>(null);
  const [historyOf, setHistoryOf] = useState<OfficeEquipmentDto | null>(null);

  const grid = {
    canWrite,
    onEdit: openEdit,
    onDelete: confirmDelete,
    onMove: setMoving,
    onHistory: setHistoryOf,
  };
  const columns = officeEquipmentColumns(grid);

  // Полоса отборов десктопа и её описание для шита живут отдельным модулем: шесть полей дважды
  // — это сто строк разметки посреди работы с данными.
  const { filters, mobileFilters } = useOfficeEquipmentFilters({
    params,
    apply: applyFilter,
    objectOptions,
    typeOptions,
    typesLoading,
    departmentOptions,
  });

  const card = officeEquipmentCard(grid);

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Модель, серийный или инвентарный номер',
          onChange: (v) => setParams((p) => ({ ...p, search: v, page: 1 })),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: canWrite
          ? { label: 'Добавить технику', icon: <PlusOutlined />, onClick: openCreate }
          : undefined,
        /*
         * Вход в окна справочников на телефоне. Десктопный слот `extra` там не рисуется вовсе —
         * полоса кнопок заняла бы весь экран, — и до появления этой строки три окна вкладки были
         * с телефона недостижимы: дверь есть, ключа нет.
         *
         * Дороже всего это стоило расходникам: остаток пересчитывают у полки, с телефона в руках,
         * а не за столом, и человек с одним правом на правку остатка до своей работы не доходил
         * вовсе. Само окно к телефону готово — карточки строк, отборы шитом, кнопка в футере.
         *
         * Порядок и права те же, что в шапке десктопа: ведение перечней типов и моделей — под
         * `officeEquipment.write`, картриджи открыты всем, кому видна оргтехника (Р10). Главное
         * действие остаётся одно («Добавить технику», круглой кнопкой), а эти живут рядом с
         * фильтрами: двух круглых кнопок у списка быть не может.
         */
        secondaryActions: [
          ...(canWrite
            ? [
                {
                  label: 'Типы оргтехники',
                  icon: <TagsOutlined />,
                  onClick: () => setTypesOpen(true),
                },
                {
                  label: 'Модели аппаратов',
                  icon: <AppstoreOutlined />,
                  onClick: () => setModelsOpen(true),
                },
              ]
            : []),
          {
            label: 'Картриджи и тонеры',
            icon: <PrinterOutlined />,
            onClick: () => setConsumablesOpen(true),
          },
        ],
      }}
      extra={
        <Space>
          {canWrite && (
            <>
              {/* Перечень типов ведут здесь же: отдельной вкладки ради десяти строк не заводят (Р34). */}
              <Button icon={<TagsOutlined />} onClick={() => setTypesOpen(true)}>
                Типы оргтехники
              </Button>
              {/* Модели — соседней кнопкой (Р8): из них выбирают в карточке техники, и ходить за
                  ними на другую вкладку пришлось бы при каждом заведении аппарата. */}
              <Button icon={<AppstoreOutlined />} onClick={() => setModelsOpen(true)}>
                Модели аппаратов
              </Button>
            </>
          )}
          {/*
           * Картриджи — третьей кнопкой того же ряда (Р8): расходник существует только при
           * технике, и отдельной вкладки «Справочников» ради него не заводят.
           *
           * Кнопка стоит вне права на парк (Р10): перечень расходников читают по
           * `officeEquipment.read` — подобрать картридж должен и тот, кто заявку заводит, — а
           * ведение номенклатуры и правку остатка спрашивает уже само окно, каждое своим правом.
           */}
          <Button icon={<PrinterOutlined />} onClick={() => setConsumablesOpen(true)}>
            Картриджи и тонеры
          </Button>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Добавить технику
            </Button>
          )}
        </Space>
      }
    >
      <DataTable<OfficeEquipmentDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />

      <OfficeEquipmentTypesModal open={typesOpen} onClose={() => setTypesOpen(false)} />
      <OfficeEquipmentModelsModal
        open={modelsOpen}
        onClose={() => setModelsOpen(false)}
        typeOptions={typeOptions}
        typesLoading={typesLoading}
      />
      <OfficeEquipmentConsumablesModal
        open={consumablesOpen}
        onClose={() => setConsumablesOpen(false)}
      />

      <FormModal
        title={record ? 'Редактирование карточки' : 'Новая единица оргтехники'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={560}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => saveMut.mutate(v)}
          {...blockers.formProps}
        >
          <OfficeEquipmentFields
            typeOptions={typeOptions}
            typesLoading={typesLoading}
            objectOptions={objectOptions}
            departmentOptions={departmentOptions}
            // Модель правящейся карточки: она может быть погашена, и без неё поле открылось бы
            // пустым — то есть правка кабинета требовала бы заодно сменить модель.
            savedModel={record?.model}
          />
        </Form>
        {/* Только у заведённой карточки: у новой единицы ни истории, ни модели ещё нет, и разделы
            «Обслуживание — ничего» и «Заправлять нечем» в форме заведения были бы шумом.
            Обе секции читают один и тот же ответ карточки — второго запроса это не стоит. */}
        {record && (
          <>
            {/* Характеристики модели: «Цветность печати: Цветная» (план
                `docs/office-equipment-specs-plan.md`). Читаются из строки, которую и открыли, —
                второго запроса это не стоит; правят их в окне «Модели аппаратов», потому что
                свойство принадлежит модели, а не этому аппарату (Р6). */}
            <OfficeEquipmentSpecsView specs={record.specs} />
            {/* «Чем заправлять» выше истории: за картриджем приходят чаще, чем за прошлым
                ремонтом, и ответ на частый вопрос не должен лежать под редким (Р15). */}
            <OfficeEquipmentSupplies equipmentId={record.id} />
            <OfficeEquipmentServiceHistory equipmentId={record.id} />
          </>
        )}
      </FormModal>

      <EquipmentMoveModal equipment={moving} onClose={() => setMoving(null)} />
      <EquipmentHistoryModal equipment={historyOf} onClose={() => setHistoryOf(null)} />
    </PageTableLayout>
  );
}
