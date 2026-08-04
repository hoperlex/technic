import { useState } from 'react';
import {
  App,
  Button,
  Checkbox,
  DatePicker,
  Form,
  Input,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteFilled,
  DeleteOutlined,
  EditOutlined,
  IdcardOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  credentialVerificationStatusColors,
  credentialVerificationStatusLabels,
  DRIVER_DOCUMENT_SETS,
  driverDocumentGapLabels,
  driverDocumentGaps,
  type DriverDocumentSet,
  driverDocumentSetLabels,
  type DriverDto,
  type DriverLicenseDto,
  formatSnils,
  isValidSnils,
  licenseCategoriesLabel,
  licenseDefect,
  licenseDefectLabels,
  licenseNumberLabel,
  licenseRequisitesMissing,
  normalizeSnils,
  SNILS_CHECKSUM_MESSAGE,
  SNILS_MESSAGE,
} from '@technic/contracts';
import { driversApi } from '../../api/resources';
import { DriversImportModal } from './DriversImportModal';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, textColumn } from '@shared/ui';
import { type FilterDefinition, sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { usePurgeAction } from './usePurgeAction';

/**
 * Справочник водителей (ADR 0037).
 *
 * Карточка заводит человека вместе с удостоверением: водитель без документа не попадёт в отбор
 * при переводе заявки в работу и молча пропадёт из формы — поэтому документ спрашивается сразу,
 * а не «когда-нибудь потом».
 *
 * Действующее удостоверение показано в строке: по нему решают, выйдет ли человек в рейс, и
 * просроченное видно списком, а не только в карточке.
 */

const DATE = 'YYYY-MM-DD';

/** Сегодняшняя дата — ею меряется годность документа в списке. */
const today = () => dayjs().format(DATE);

interface LicenseFormValues {
  series?: string;
  number: string;
  issuedOn?: dayjs.Dayjs;
  expiresOn?: dayjs.Dayjs;
  categoryIds: string[];
}

interface DriverFormValues {
  lastName: string;
  firstName: string;
  middleName?: string;
  snils: string;
  phone?: string;
  personnelNo?: string;
  comment?: string;
  license?: LicenseFormValues;
}

/** Действующий документ — первый в списке: сервер отдаёт их от свежего к старому. */
function currentLicense(d: DriverDto): DriverLicenseDto | undefined {
  return d.licenses[0];
}

/**
 * Чего не хватает для путевого листа — из того, о чём строка ещё не сказала. «Действующего
 * удостоверения нет» и «серия и номер не внесены» она называет своими словами и своими местами,
 * а вот пустая дата выдачи не видна нигде: без неё лист печатается с пустой графой, и человек,
 * отобравший неполный комплект фильтром, обязан понимать, что именно вносить.
 */
function unsaidGaps(d: DriverDto): string[] {
  return driverDocumentGaps(d, today())
    .filter((g) => g !== 'license' && g !== 'requisites')
    .map((g) => driverDocumentGapLabels[g]);
}

export function DriversTab() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const canWrite = can('drivers.write');
  const qc = useQueryClient();

  // Архив справочника (ADR 0021): удалённые водители видны по `archive.read`, сносит их насовсем
  // администратор (ADR 0060). До этого удалённая карточка не показывалась вовсе — её и не
  // удалить было, и не проверить.
  const canSeeArchive = can('archive.read');

  const { params, setParams, setSort, onTableChange } = useListParams<{
    documents?: DriverDocumentSet;
    categoryId?: string;
    includeDeleted?: string;
  }>({}, { searchKeys: ['fullName', 'snils'] });
  const { data, isFetching } = useQuery({
    queryKey: ['drivers', params],
    queryFn: () => driversApi.list(params),
  });

  // Категории водительского удостоверения: справочник наполнен миграцией и не меняется, поэтому
  // берётся один раз и живёт в кэше до перезагрузки страницы.
  const { data: categories } = useQuery({
    queryKey: ['license-categories'],
    queryFn: () => driversApi.licenseCategories(),
    staleTime: Infinity,
  });
  const categoryOptions = (categories ?? []).map((c) => ({
    value: c.id,
    label: `${c.name} — ${c.description}`,
  }));

  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [record, setRecord] = useState<DriverDto | null>(null);
  const [licenseFor, setLicenseFor] = useState<DriverDto | null>(null);
  const [form] = Form.useForm<DriverFormValues>();
  const [licenseForm] = Form.useForm<LicenseFormValues>();

  const openCreate = () => {
    setRecord(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (d: DriverDto) => {
    setRecord(d);
    form.resetFields();
    form.setFieldsValue({
      lastName: d.lastName,
      firstName: d.firstName,
      middleName: d.middleName,
      snils: formatSnils(d.snils),
      phone: d.phone,
      personnelNo: d.personnelNo,
      comment: d.comment,
    });
    setOpen(true);
  };

  const openLicense = (d: DriverDto) => {
    setLicenseFor(d);
    licenseForm.resetFields();
    setOpen(false);
  };

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['drivers'] });

  const saveMut = useMutation({
    mutationFn: (values: DriverFormValues) => {
      const base = {
        lastName: values.lastName,
        firstName: values.firstName,
        middleName: values.middleName ?? '',
        snils: values.snils,
        phone: values.phone ?? '',
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
                categories: values.license.categoryIds.map((categoryId) => ({ categoryId })),
              },
            }
          : {}),
      });
    },
    onSuccess: () => {
      message.success('Сохранено');
      invalidate();
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const licenseMut = useMutation({
    mutationFn: (values: LicenseFormValues) =>
      driversApi.addLicense(licenseFor!.id, {
        series: values.series ?? '',
        number: values.number,
        issuedOn: values.issuedOn?.format(DATE) ?? null,
        expiresOn: values.expiresOn?.format(DATE) ?? null,
        categories: values.categoryIds.map((categoryId) => ({ categoryId })),
      }),
    onSuccess: () => {
      message.success('Удостоверение добавлено');
      invalidate();
      setLicenseFor(null);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const verifyMut = useMutation({
    mutationFn: ({ d, status }: { d: DriverDto; status: 'verified' | 'rejected' }) =>
      driversApi.verifyLicense(d.id, currentLicense(d)!.id, { verificationStatus: status }),
    onSuccess: () => {
      message.success('Отметка проверки сохранена');
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const revokeMut = useMutation({
    mutationFn: ({ d, reason }: { d: DriverDto; reason: string }) =>
      driversApi.revokeLicense(d.id, currentLicense(d)!.id, { revokeReason: reason }),
    onSuccess: () => {
      message.success('Удостоверение аннулировано');
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => driversApi.remove(id),
    onSuccess: () => {
      message.success('Водитель удалён');
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем (ADR 0060): вместе с человеком уходят его документы и сканы. Только из
  // архива и только администратору — путевые листы держат водителя внешним ключом.
  const purge = usePurgeAction({
    subject: 'водителя',
    purge: driversApi.purge,
    invalidate: ['drivers'],
  });

  const confirmRemove = (d: DriverDto) =>
    modal.confirm({
      title: `Удалить водителя «${d.fullName}»?`,
      // Пометка, а не стирание: на водителя ссылаются выданные путевые листы.
      content: 'Выданные путевые листы сохранятся, но в отбор он больше не попадёт.',
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeMut.mutateAsync(d.id),
    });

  const confirmRevoke = (d: DriverDto) => {
    let reason = '';
    modal.confirm({
      title: 'Аннулировать удостоверение?',
      content: (
        <Input.TextArea
          rows={2}
          placeholder="Причина: лишение права управления, утрата документа…"
          onChange={(e) => {
            reason = e.target.value;
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
        await revokeMut.mutateAsync({ d, reason });
      },
    });
  };

  const columns = [
    textColumn<DriverDto>({ key: 'fullName', title: 'ФИО', dataIndex: 'fullName' }),
    textColumn<DriverDto>({
      key: 'snils',
      title: 'СНИЛС',
      dataIndex: 'snils',
      width: 160,
      render: (_v, r) => formatSnils(r.snils),
    }),
    textColumn<DriverDto>({
      key: 'personnelNo',
      title: 'Табельный',
      dataIndex: 'personnelNo',
      width: 130,
    }),
    textColumn<DriverDto>({
      key: 'license',
      title: 'Удостоверение',
      dataIndex: 'licenses',
      sortable: false,
      searchable: false,
      width: 260,
      render: (_v, r) => {
        const license = currentLicense(r);
        const gaps = unsaidGaps(r);
        const missing = gaps.length > 0 && (
          <Typography.Text type="warning">{gaps.join(' · ')}</Typography.Text>
        );
        if (!license) {
          return (
            <Space direction="vertical" size={0}>
              <Typography.Text type="secondary">Не заведено</Typography.Text>
              {missing}
            </Space>
          );
        }
        const defect = licenseDefect(license, today());
        // Реквизитов нет у документов из кадровой выгрузки: без этой ветки строка начиналась бы
        // с осиротевшего разделителя, и «не внесено» читалось бы как сбой вёрстки.
        const noRequisites = licenseRequisitesMissing(licenseNumberLabel(license));
        return (
          <Space direction="vertical" size={0}>
            <span>
              {noRequisites ? (
                <Typography.Text type="warning">Серия и номер не внесены</Typography.Text>
              ) : (
                licenseNumberLabel(license)
              )}
            </span>
            <Space size={4}>
              {defect ? (
                <Tag color="red">{licenseDefectLabels[defect]}</Tag>
              ) : (
                <Typography.Text type="secondary">
                  {license.expiresOn
                    ? `до ${dayjs(license.expiresOn).format('DD.MM.YYYY')}`
                    : 'бессрочно'}
                </Typography.Text>
              )}
              <Tag color={credentialVerificationStatusColors[license.verificationStatus]}>
                {credentialVerificationStatusLabels[license.verificationStatus]}
              </Tag>
            </Space>
            {missing}
          </Space>
        );
      },
    }),
    /**
     * Категории — своей колонкой (ADR 0055): отбор водителя под машину ими не сужается, и
     * единственное место, где о них узнают, — справочник. Приклеенные к номеру удостоверения,
     * они читались хуже и не искались глазами, а спрашивают их отдельным вопросом: «кто у нас
     * с CE».
     */
    textColumn<DriverDto>({
      key: 'categories',
      title: 'Категории',
      dataIndex: 'licenses',
      sortable: false,
      searchable: false,
      width: 160,
      render: (_v, r) => {
        const license = currentLicense(r);
        const label = license ? licenseCategoriesLabel(license) : '';
        return label || <Typography.Text type="secondary">—</Typography.Text>;
      },
    }),
    ...(canWrite
      ? [
          actionsColumn<DriverDto>((r) =>
            r.deletedAt ? (
              <Space>
                <Tag>в архиве</Tag>
                {purge.allowed ? (
                  <Button
                    size="small"
                    danger
                    icon={<DeleteFilled />}
                    title="Удалить окончательно"
                    loading={purge.pending}
                    onClick={() => purge.confirm(r.id, r.fullName)}
                  />
                ) : null}
              </Space>
            ) : (
              <Space>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
                <Button
                  size="small"
                  icon={<IdcardOutlined />}
                  title="Заменить удостоверение"
                  onClick={() => openLicense(r)}
                />
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => confirmRemove(r)}
                />
              </Space>
            ),
          ),
        ]
      : []),
  ];

  const documentSetOptions = DRIVER_DOCUMENT_SETS.map((v) => ({
    value: v,
    label: driverDocumentSetLabels[v],
  }));

  const setDocuments = (v: DriverDocumentSet | undefined) =>
    setParams((p) => ({ ...p, documents: v, page: 1 }));
  const setCategory = (v: string | undefined) =>
    setParams((p) => ({ ...p, categoryId: v, page: 1 }));

  /**
   * Комплект документов и категория — два вопроса к справочнику. Первый: путевой лист печатает
   * СНИЛС, номер удостоверения и дату его выдачи, и половина работы со справочником — дозаполнить
   * тех, у кого чего-то нет; обратное значение нужно не реже — «кем можно закрывать рейсы».
   * Второй появился, когда категория перестала сужать отбор под машину (ADR 0055): «кого можно
   * посадить за седельный тягач» спрашивают здесь, и глазами по списку это не считается.
   *
   * Категория в фильтре названа буквой с описанием — тем же списком, что и в карточке: искать её
   * будут по букве из удостоверения, а не по формулировке правил.
   */
  const filters = (
    <Space wrap>
      <Select<DriverDocumentSet>
        allowClear
        placeholder="Комплект документов"
        style={{ width: 200 }}
        options={documentSetOptions}
        value={params.documents}
        onChange={setDocuments}
      />
      <Select<string>
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Категория"
        style={{ width: 220 }}
        options={categoryOptions}
        value={params.categoryId}
        onChange={setCategory}
      />
      {canSeeArchive ? (
        <Checkbox
          checked={params.includeDeleted === 'true'}
          onChange={(e) =>
            setParams((p) => ({
              ...p,
              includeDeleted: e.target.checked ? 'true' : undefined,
              page: 1,
            }))
          }
        >
          Показать архив
        </Checkbox>
      ) : null}
    </Space>
  );

  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'documents',
      label: 'Комплект документов',
      value: params.documents,
      options: documentSetOptions,
      placeholder: 'Все',
      onChange: (v) => setDocuments(v as DriverDocumentSet | undefined),
    },
    {
      kind: 'select',
      key: 'categoryId',
      label: 'Категория',
      value: params.categoryId,
      options: categoryOptions,
      placeholder: 'Любая',
      onChange: (v) => setCategory(v as string | undefined),
    },
    ...(canSeeArchive
      ? [
          {
            kind: 'toggle' as const,
            key: 'includeDeleted',
            label: 'Показывать архив',
            value: params.includeDeleted === 'true',
            onChange: (checked: boolean) =>
              setParams((p) => ({ ...p, includeDeleted: checked ? 'true' : undefined, page: 1 })),
          },
        ]
      : []),
  ];

  /** Документы водителя в карточке: история и учётные действия над действующим. */
  function licensesBlock(d: DriverDto) {
    const license = currentLicense(d);
    return (
      <>
        <Typography.Title level={5}>Удостоверения</Typography.Title>
        {d.licenses.length === 0 && (
          <Typography.Paragraph type="secondary">
            Не заведено — в выбор при переводе заявки в работу водитель не попадёт.
          </Typography.Paragraph>
        )}
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          {d.licenses.map((l, i) => {
            const defect = licenseDefect(l, today());
            return (
              <Space key={l.id} size={8} wrap>
                <span>
                  {i === 0 ? 'Действующее:' : 'Прежнее:'} {licenseNumberLabel(l)} ·{' '}
                  {licenseCategoriesLabel(l)}
                </span>
                {l.expiresOn && <span>до {dayjs(l.expiresOn).format('DD.MM.YYYY')}</span>}
                {defect && <Tag color="red">{licenseDefectLabels[defect]}</Tag>}
                <Tag color={credentialVerificationStatusColors[l.verificationStatus]}>
                  {credentialVerificationStatusLabels[l.verificationStatus]}
                </Tag>
                {l.verifiedByName && (
                  <Typography.Text type="secondary">проверил {l.verifiedByName}</Typography.Text>
                )}
                {l.revokeReason && (
                  <Typography.Text type="danger">{l.revokeReason}</Typography.Text>
                )}
              </Space>
            );
          })}
        </Space>
        {canWrite && (
          <Space wrap style={{ marginTop: 12 }}>
            <Button size="small" icon={<IdcardOutlined />} onClick={() => openLicense(d)}>
              Заменить
            </Button>
            {license && !license.revokedAt && (
              <>
                <Button
                  size="small"
                  onClick={() => verifyMut.mutate({ d, status: 'verified' })}
                  disabled={license.verificationStatus === 'verified'}
                >
                  Отметить проверенным
                </Button>
                <Button
                  size="small"
                  onClick={() => verifyMut.mutate({ d, status: 'rejected' })}
                  disabled={license.verificationStatus === 'rejected'}
                >
                  Отклонить
                </Button>
                <Button size="small" danger onClick={() => confirmRevoke(d)}>
                  Аннулировать
                </Button>
              </>
            )}
          </Space>
        )}
      </>
    );
  }

  /** СНИЛС набирают так, как он напечатан; контрольная сумма ловит опечатку в одной цифре. */
  const snilsRules = [
    { required: true, message: 'Обязательное поле' },
    {
      validator: (_: unknown, value: string) => {
        if (!value) return Promise.resolve();
        const digits = normalizeSnils(value);
        if (!/^\d{11}$/u.test(digits)) return Promise.reject(new Error(SNILS_MESSAGE));
        if (!isValidSnils(digits)) return Promise.reject(new Error(SNILS_CHECKSUM_MESSAGE));
        return Promise.resolve();
      },
    },
  ];

  /**
   * Карточка водителя на телефоне (ADR 0042): ФИО и состояние удостоверения — то, ради чего
   * справочник и открывают. Дефект документа выведен строкой, а не подсказкой на теге: на
   * касании подсказка не открывается (ADR 0030 п. 6).
   */
  const card: CardConfig<DriverDto> = {
    title: (r) => r.fullName,
    badge: (r) => {
      // Архив — первым делом: у удалённой карточки состояние документа уже ничего не решает.
      if (r.deletedAt) return <Tag>в архиве</Tag>;
      const license = currentLicense(r);
      if (!license) return <Tag>нет ВУ</Tag>;
      const defect = licenseDefect(license, today());
      return defect ? (
        <Tag color="red">{licenseDefectLabels[defect]}</Tag>
      ) : (
        <Tag color={credentialVerificationStatusColors[license.verificationStatus]}>
          {credentialVerificationStatusLabels[license.verificationStatus]}
        </Tag>
      );
    },
    primary: (r) => {
      const license = currentLicense(r);
      if (!license) return 'Удостоверение не заведено';
      return licenseRequisitesMissing(licenseNumberLabel(license))
        ? 'Серия и номер не внесены'
        : licenseNumberLabel(license);
    },
    lines: [
      // Категории — своей строкой, как и своей колонкой на большом экране (ADR 0055): за ними
      // в справочник и приходят, а приклеенные к номеру они терялись.
      (r) => {
        const license = currentLicense(r);
        const label = license ? licenseCategoriesLabel(license) : '';
        return label ? `Категории: ${label}` : null;
      },
      (r) => {
        const license = currentLicense(r);
        if (!license) return null;
        return license.expiresOn
          ? `Действует до ${dayjs(license.expiresOn).format('DD.MM.YYYY')}`
          : 'Бессрочное';
      },
      // Недостающее для листа — строкой: на карточке пустой графы не видно, а отобрав неполный
      // комплект фильтром, человек должен понимать, что именно вносить.
      (r) => unsaidGaps(r).join(' · ') || null,
      (r) => (r.personnelNo ? `Таб. № ${r.personnelNo}` : null),
      (r) => (r.snils ? `СНИЛС ${formatSnils(r.snils)}` : null),
    ],
    onOpen: canWrite ? (r) => (r.deletedAt ? undefined : openEdit(r)) : undefined,
    actions: (r) => {
      if (!canWrite) return [];
      if (r.deletedAt) {
        return purge.allowed
          ? [
              {
                key: 'purge',
                label: 'Удалить окончательно',
                danger: true,
                onClick: () => purge.confirm(r.id, r.fullName),
              },
            ]
          : [];
      }
      return [
        { key: 'edit', label: 'Редактировать', onClick: () => openEdit(r) },
        { key: 'license', label: 'Заменить удостоверение', onClick: () => openLicense(r) },
        { key: 'delete', label: 'Удалить', danger: true, onClick: () => confirmRemove(r) },
      ];
    },
  };

  return (
    <PageTableLayout
      filters={filters}
      // На телефоне справочник читается карточками, поиск и сортировка — в панели (ADR 0042).
      mobile={{
        search: {
          value: params.search,
          placeholder: 'ФИО или СНИЛС',
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
          ? {
              label: 'Добавить водителя',
              icon: <PlusOutlined />,
              onClick: openCreate,
            }
          : undefined,
      }}
      extra={
        canWrite ? (
          <Space>
            {/* Кадровая выгрузка приходит файлом на весь отдел: заводить два десятка человек
                формой по одному — работа на день, а ошибка в СНИЛС обнаружится на путевом листе. */}
            <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
              Загрузить выгрузку
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Добавить водителя
            </Button>
          </Space>
        ) : undefined
      }
    >
      <DataTable<DriverDto>
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

      <FormModal
        title={record ? 'Карточка водителя' : 'Новый водитель'}
        open={open}
        onCancel={() => setOpen(false)}
        onSubmit={() => form.submit()}
        confirmLoading={saveMut.isPending}
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
          <Form.Item name="lastName" label="Фамилия" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="firstName" label="Имя" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="middleName" label="Отчество">
            <Input />
          </Form.Item>
          <Form.Item
            name="snils"
            label="СНИЛС"
            rules={snilsRules}
            // Печатается в путевом листе — без него лист недействителен (приказ Минтранса № 390).
            extra="Обязательный реквизит путевого листа"
          >
            <Input placeholder="112-233-445 95" />
          </Form.Item>
          <Form.Item name="personnelNo" label="Табельный номер">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Телефон">
            <Input />
          </Form.Item>
          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={2} />
          </Form.Item>

          {record && licensesBlock(record)}

          {!record && (
            <>
              <Typography.Title level={5}>Водительское удостоверение</Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
                Без документа водитель не попадёт в выбор при переводе заявки в работу.
              </Typography.Paragraph>
              <Form.Item name={['license', 'series']} label="Серия">
                <Input placeholder="99 39" />
              </Form.Item>
              <Form.Item name={['license', 'number']} label="Номер">
                <Input placeholder="482645" />
              </Form.Item>
              <Form.Item name={['license', 'issuedOn']} label="Дата выдачи">
                <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
              </Form.Item>
              <Form.Item name={['license', 'expiresOn']} label="Действительно до">
                <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
              </Form.Item>
              <Form.Item name={['license', 'categoryIds']} label="Категории">
                <Select mode="multiple" options={categoryOptions} placeholder="B, C, CE" />
              </Form.Item>
            </>
          )}
        </Form>
      </FormModal>

      <FormModal
        title="Новое удостоверение"
        open={licenseFor !== null}
        onCancel={() => setLicenseFor(null)}
        onSubmit={() => licenseForm.submit()}
        confirmLoading={licenseMut.isPending}
        width={480}
      >
        <Form form={licenseForm} layout="vertical" onFinish={(v) => licenseMut.mutate(v)}>
          <Typography.Paragraph type="secondary">
            Прежнее удостоверение останется в карточке: по нему объясняются листы прошлых лет.
          </Typography.Paragraph>
          <Form.Item name="series" label="Серия">
            <Input placeholder="99 39" />
          </Form.Item>
          <Form.Item name="number" label="Номер" rules={[{ required: true }]}>
            <Input placeholder="482645" />
          </Form.Item>
          <Form.Item name="issuedOn" label="Дата выдачи">
            <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
          </Form.Item>
          <Form.Item name="expiresOn" label="Действительно до">
            <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
          </Form.Item>
          <Form.Item name="categoryIds" label="Категории" rules={[{ required: true }]}>
            <Select mode="multiple" options={categoryOptions} placeholder="B, C, CE" />
          </Form.Item>
        </Form>
      </FormModal>

      <DriversImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={invalidate}
      />
    </PageTableLayout>
  );
}
