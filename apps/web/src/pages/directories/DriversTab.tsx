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
} from '@ant-design/icons';
import type dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CREDENTIAL_TYPE_CODES,
  type CredentialTypeCode,
  credentialTypeLabels,
  credentialTypeShortLabels,
  DRIVER_DOCUMENT_SETS,
  EMAIL_FORMAT_MESSAGE,
  type DriverDocumentSet,
  driverDocumentSetLabels,
  type DriverDto,
  type DriverLicenseDto,
  formatSnils,
  isValidSnils,
  licenseNumberLabel,
  normalizeSnils,
  optionalEmailSchema,
  requiredCredentialType,
  SNILS_CHECKSUM_MESSAGE,
  SNILS_MESSAGE,
} from '@technic/contracts';
import { driversApi } from '../../api/resources';
import { PhoneField, PhoneLink } from '../../components/PhoneField';
import { garageKeys } from '@entities/garage';
import { DataTable, type CardConfig } from '@shared/ui';
import { FormModal, useFormBlockers } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { actionsColumn, textColumn } from '@shared/ui';
import { type FilterDefinition, sortOptionsFrom } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import {
  documentBadge,
  documentCardLines,
  documentColumns,
  documentPrimary,
  documentsBlock,
  type DriverDocumentActions,
} from './driverDocuments';

/**
 * Справочник водителей (ADR 0037, ADR 0095).
 *
 * Карточка заводит человека вместе с удостоверением: водитель без документа не попадёт в отбор
 * при переводе заявки в работу и молча пропадёт из формы — поэтому документ спрашивается сразу,
 * а не «когда-нибудь потом».
 *
 * Действующее удостоверение показано в строке: по нему решают, выйдет ли человек в рейс, и
 * просроченное видно списком, а не только в карточке.
 *
 * Документов два вида — водительское и тракториста-машиниста, — и каждый показан своей парой
 * колонок: у машиниста погрузчика «C» стоит в тракторном, и сведённые в одну графу буквы читались
 * бы как допуск к грузовику. Каким документом человек допущен, говорит должность
 * (`requiredCredentialType`), она же убирает лишнюю пару колонок, когда по должности фильтруют.
 *
 * Сам показ бумаг — колонки, строки карточки и блоки в форме — живёт соседним модулем
 * `driverDocuments`: здесь остаются состояние справочника, запросы и окна.
 */

const DATE = 'YYYY-MM-DD';

interface LicenseFormValues {
  series?: string;
  number: string;
  issuedOn?: dayjs.Dayjs;
  expiresOn?: dayjs.Dayjs;
  /** У тракторного категорий может не быть вовсе: в кадровой выгрузке их не присылают. */
  categoryIds?: string[];
  /** Убрать прежний документ этого вида вместо того, чтобы оставить его историей. */
  deletePrevious?: boolean;
}

interface DriverFormValues {
  lastName: string;
  firstName: string;
  middleName?: string;
  snils: string;
  phone?: string;
  email?: string;
  personnelNo?: string;
  comment?: string;
  license?: LicenseFormValues;
}

/**
 * Категории вида документа для формы и для фильтра: справочник наполнен миграцией и не меняется,
 * поэтому берётся один раз на вид и живёт в кэше до перезагрузки страницы. Ключом стоит вид: два
 * места на экране спрашивают его одновременно, и общий ключ подсунул бы одному из них чужие буквы.
 */
function useLicenseCategoryOptions(type: CredentialTypeCode) {
  const { data } = useQuery({
    queryKey: ['license-categories', type],
    queryFn: () => driversApi.licenseCategories(type),
    staleTime: Infinity,
  });
  return (data ?? []).map((c) => ({ value: c.id, label: `${c.name} — ${c.description}` }));
}

export function DriversTab() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const canWrite = can('drivers.write');
  // Убрать документ из карточки — правом администратора (ADR 0021): ведение документов и стирание
  // заведённого это разные полномочия. Тем же правом закрыта галочка замены со снятием прежнего.
  const canDeleteLicense = can('records.purge');
  const qc = useQueryClient();

  // Архив справочника (ADR 0021): удалённые водители видны по `archive.read`, сносит их насовсем
  // администратор (ADR 0060). До этого удалённая карточка не показывалась вовсе — её и не
  // удалить было, и не проверить.
  const canSeeArchive = can('archive.read');

  const { params, setParams, setSort, onTableChange } = useListParams<{
    documents?: DriverDocumentSet;
    jobTitle?: string;
    categoryId?: string;
    includeDeleted?: string;
    // Ключ столбца, а не поле записи: поиск в шапке «Контактов» ищет и по адресу, и по номеру —
    // разбирает запрос сервер (`phoneSearchCondition`).
  }>({}, { searchKeys: ['fullName', 'snils', 'contacts'] });
  const { data, isFetching } = useQuery({
    queryKey: ['drivers', params],
    queryFn: () => driversApi.list(params),
  });

  // Должности для фильтра — списком с сервера: справочника должностей нет, они приходят из кадров
  // свободным текстом (ADR 0095), и перечислить их наперёд портал не может. Ключ начинается с
  // `drivers`, чтобы заведённый водитель обновлял и счётчики должностей.
  const { data: jobTitles } = useQuery({
    queryKey: ['drivers', 'job-titles'],
    queryFn: () => driversApi.jobTitles(),
  });

  /**
   * Вид документа, о котором справочник спрашивает сейчас: его называет фильтр по должности. Без
   * фильтра — водительское, как справочник и открывался: он про водителей, а вторая пара колонок
   * рядом видна и так.
   */
  const filterType = params.jobTitle ? requiredCredentialType(params.jobTitle) : 'driver_license';
  const filterCategoryOptions = useLicenseCategoryOptions(filterType);
  // Форма заведения водителя спрашивает только водительское: должность там не выбирают, а новый
  // человек заводится водителем (`createDriverSchema`). Тракторное заводят вторым шагом — окном
  // «Новое удостоверение», где вид документа спрашивается прямо.
  const driverLicenseOptions = useLicenseCategoryOptions('driver_license');

  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<DriverDto | null>(null);
  const [licenseFor, setLicenseFor] = useState<DriverDto | null>(null);
  const [form] = Form.useForm<DriverFormValues>();
  const [licenseForm] = Form.useForm<LicenseFormValues>();
  /**
   * Отказы сервера по документу помечают поле, а не уходят тостом (ADR 0094). Заведено ради
   * занятого номера: он теперь отвечает `validation_error` с полем `number`, и подсказка нужна
   * там, где её правят, — иначе человек ищет в окне то, что портал уже знает.
   */
  const licenseBlockers = useFormBlockers(licenseForm);
  /**
   * Вид документа окна «Новое удостоверение» — состоянием рядом с формой, а не её полем: окно
   * открывается с видом по должности, а форма к этому моменту ещё не смонтирована — значение,
   * положенное в неё до первого показа, теряется. Смена вида ещё и чистит выбранные категории:
   * они записи справочника своего вида, и отправить на сервер буквы чужого документа нельзя.
   */
  const [licenseType, setLicenseType] = useState<CredentialTypeCode>('driver_license');
  const licenseCategoryOptions = useLicenseCategoryOptions(licenseType);
  /** Что снимет галочка замены: все документы выбранного вида, а не только действующий. */
  const previousOfType = (licenseFor?.licenses ?? []).filter(
    (l) => l.credentialTypeCode === licenseType,
  );

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
      email: d.email,
      personnelNo: d.personnelNo,
      comment: d.comment,
    });
    setOpen(true);
  };

  /**
   * Заведение документа. Вид подставляется по должности карточки: у машиниста экскаватора заводят
   * тракторное в девяти случаях из десяти, а выбор остаётся — у машиниста автокрана в кадрах стоит
   * водительское, и должность списку известна не всякая (ADR 0095).
   */
  const openLicense = (d: DriverDto, type = requiredCredentialType(d.jobTitle)) => {
    setLicenseFor(d);
    setLicenseType(type);
    licenseForm.resetFields();
    setOpen(false);
  };

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['drivers'] });
    void qc.invalidateQueries({ queryKey: garageKeys.root });
  };

  const saveMut = useMutation({
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
      invalidate();
      setOpen(false);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const licenseMut = useMutation({
    mutationFn: (values: LicenseFormValues) =>
      driversApi.addLicense(licenseFor!.id, {
        credentialType: licenseType,
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
      setLicenseFor(null);
    },
    onError: (e) => {
      if (!licenseBlockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  /**
   * Убрать документ из карточки. Не аннулирование: то говорит «документ был и перестал
   * действовать», а это — «его тут быть не должно» (опечатка в номере, чужая строка выгрузки,
   * второй экземпляр того же удостоверения). Заодно освобождается серия с номером: пока лишний
   * документ лежит в карточке, настоящий с тем же номером не заводится вовсе.
   */
  const deleteLicenseMut = useMutation({
    mutationFn: ({ d, license }: { d: DriverDto; license: DriverLicenseDto }) =>
      driversApi.deleteLicense(d.id, license.id),
    onSuccess: () => {
      message.success('Документ убран из карточки');
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmDeleteLicense = (d: DriverDto, license: DriverLicenseDto) =>
    modal.confirm({
      title: `Убрать ${credentialTypeShortLabels[license.credentialTypeCode]} ${licenseNumberLabel(license)}?`,
      content:
        'Документ пропадёт из карточки и из отбора, а выданные по нему путевые листы сохранятся. ' +
        'Восстановить его из портала нельзя — заводить придётся заново.',
      okText: 'Убрать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => deleteLicenseMut.mutateAsync({ d, license }),
    });

  // Документ адресуется идентификатором, а не «действующим у водителя»: документов у человека два
  // вида, и «действующий» без вида означал бы отметку проверки, поставленную не той бумаге.
  const verifyMut = useMutation({
    mutationFn: ({
      d,
      license,
      status,
    }: {
      d: DriverDto;
      license: DriverLicenseDto;
      status: 'verified' | 'rejected';
    }) => driversApi.verifyLicense(d.id, license.id, { verificationStatus: status }),
    onSuccess: () => {
      message.success('Отметка проверки сохранена');
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const revokeMut = useMutation({
    mutationFn: ({
      d,
      license,
      reason,
    }: {
      d: DriverDto;
      license: DriverLicenseDto;
      reason: string;
    }) => driversApi.revokeLicense(d.id, license.id, { revokeReason: reason }),
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
    invalidate: [['drivers']],
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

  const confirmRevoke = (d: DriverDto, license: DriverLicenseDto) => {
    let reason = '';
    modal.confirm({
      title: `Аннулировать ${credentialTypeShortLabels[license.credentialTypeCode]}?`,
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
        await revokeMut.mutateAsync({ d, license, reason });
      },
    });
  };

  /**
   * Какие виды документов показывать. Без фильтра — оба: справочник для того и открывают, чтобы
   * увидеть, у кого чего нет. С выбранной должностью — только её собственный: колонки ВУ у
   * машиниста экскаватора пусты у всех строк и лишь занимают ширину (ADR 0095).
   */
  const visibleTypes: CredentialTypeCode[] = params.jobTitle
    ? [filterType]
    : [...CREDENTIAL_TYPE_CODES];

  const columns = [
    textColumn<DriverDto>({ key: 'fullName', title: 'ФИО', dataIndex: 'fullName' }),
    // Второй колонкой, сразу за ФИО: с рассылкой заданий и звонком водителю контакты спрашивают
    // чаще СНИЛС и табельного, а пустые ячейки в начале строки видно, не досматривая таблицу до
    // конца. Адрес и номер — одна графа в две строки, а не два столбца: их читают вместе, вопрос
    // у человека один — «как достать этого водителя».
    // Сортировки нет: колонка отвечает на «есть ли контакты», а не «кто первый по алфавиту» —
    // сортировать по ней значит гонять пустые строки то вверх, то вниз.
    // Отсутствие пишется словом, а не пустотой: пустая ячейка читается как «не досмотрели», а
    // «не указан» — как «звонить некуда, и это известно».
    textColumn<DriverDto>({
      key: 'contacts',
      title: 'Контакты',
      dataIndex: 'email',
      sortable: false,
      width: 220,
      render: (_v, r) => (
        <>
          {r.email || <Typography.Text type="secondary">email не указан</Typography.Text>}
          <br />
          {r.phone ? (
            <PhoneLink phone={r.phone} />
          ) : (
            <Typography.Text type="secondary">телефон не указан</Typography.Text>
          )}
        </>
      ),
    }),
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
    // Должность — рядом с табельным: она приходит из тех же кадров и отвечает на вопрос, какой
    // документ у человека спрашивать. Сортировки нет: должностей десяток, и порядок по ним
    // заменяется фильтром, который к тому же убирает лишние колонки.
    textColumn<DriverDto>({
      key: 'jobTitle',
      title: 'Должность',
      dataIndex: 'jobTitle',
      sortable: false,
      searchable: false,
      width: 180,
      render: (_v, r) => r.jobTitle || <Typography.Text type="secondary">—</Typography.Text>,
    }),
    ...visibleTypes.flatMap((type) => documentColumns(type)),
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

  /**
   * Должности со счётчиком: «машинист экскаватора (12)». Число не украшение — им видно опечатку
   * кадровой выгрузки: та же должность, записанная иначе, встанет второй строкой на одного
   * человека, и это повод поправить кадры, а не портал (ADR 0095).
   */
  const jobTitleOptions = (jobTitles ?? []).map((t) => ({
    value: t.jobTitle,
    label: `${t.jobTitle} (${t.count})`,
  }));

  const setDocuments = (v: DriverDocumentSet | undefined) =>
    setParams((p) => ({ ...p, documents: v, page: 1 }));
  // Вместе с должностью сбрасывается категория: буквы у видов документов одни и те же, но
  // категория — запись справочника своего вида, и «C» водительского не найдёт ни одного машиниста
  // экскаватора. Список молча опустел бы, а человек читал бы это как «таких нет».
  const setJobTitle = (v: string | undefined) =>
    setParams((p) => ({ ...p, jobTitle: v, categoryId: undefined, page: 1 }));
  const setCategory = (v: string | undefined) =>
    setParams((p) => ({ ...p, categoryId: v, page: 1 }));

  /**
   * Комплект документов, должность и категория — три вопроса к справочнику. Первый: путевой лист
   * печатает СНИЛС, номер удостоверения и дату его выдачи, и половина работы со справочником —
   * дозаполнить тех, у кого чего-то нет; обратное значение нужно не реже — «кем можно закрывать
   * рейсы». Второй пришёл со вторым видом документа (ADR 0095): «что с бумагами у машинистов»
   * спрашивают отдельно от водителей, и лишние колонки этому мешают. Третий появился, когда
   * категория перестала сужать отбор под машину (ADR 0055): «кого можно посадить за седельный
   * тягач» спрашивают здесь, и глазами по списку это не считается.
   *
   * Категория в фильтре названа буквой с описанием — тем же списком, что и в карточке: искать её
   * будут по букве из удостоверения, а не по формулировке правил. Список — того вида документа,
   * который назвала должность: буквы у видов совпадают, и общий перечень предлагал бы выбрать
   * категорию, которой у отобранных людей быть не может.
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
        placeholder="Должность"
        style={{ width: 220 }}
        options={jobTitleOptions}
        value={params.jobTitle}
        onChange={setJobTitle}
      />
      <Select<string>
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder={`Категория ${credentialTypeShortLabels[filterType]}`}
        style={{ width: 220 }}
        options={filterCategoryOptions}
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
      key: 'jobTitle',
      label: 'Должность',
      value: params.jobTitle,
      options: jobTitleOptions,
      placeholder: 'Любая',
      onChange: (v) => setJobTitle(v as string | undefined),
    },
    {
      kind: 'select',
      key: 'categoryId',
      label: `Категория ${credentialTypeShortLabels[filterType]}`,
      value: params.categoryId,
      options: filterCategoryOptions,
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

  /** Учётные действия блоков документов: сами блоки — в `driverDocuments`, запросы и окна здесь. */
  const documentActions: DriverDocumentActions = {
    canWrite,
    onReplace: openLicense,
    onVerify: (d, license, status) => verifyMut.mutate({ d, license, status }),
    onRevoke: confirmRevoke,
    canDelete: canDeleteLicense,
    onDelete: confirmDeleteLicense,
  };

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
   *
   * Заголовок карточки говорит о документе по должности: у машиниста экскаватора спрашивают
   * тракторное, и пустое ВУ выносить наверх незачем. Второй документ виден строками ниже — но
   * только пока по должности не отфильтровали (`visibleTypes`).
   */
  const card: CardConfig<DriverDto> = {
    title: (r) => r.fullName,
    // Архив — первым делом: у удалённой карточки состояние документа уже ничего не решает.
    badge: (r) => (r.deletedAt ? <Tag>в архиве</Tag> : documentBadge(r)),
    primary: documentPrimary,
    lines: [
      // Контакты — первыми строками, как и второй колонкой на большом экране: с рассылкой заданий
      // и звонком водителю их спрашивают чаще прочих реквизитов. Отсутствие пишется словом, а не
      // пропуском строки, как у недостающего для листа ниже: на карточке пустой графы не видно, а
      // «адреса нет» означает, что задание такому водителю не уйдёт.
      (r) =>
        r.email ? (
          `Email: ${r.email}`
        ) : (
          <Typography.Text type="secondary">Email не указан</Typography.Text>
        ),
      // Номер ссылкой: карточками справочник читают с телефона, и звонок — то, ради чего номер
      // здесь и стоит (ADR 0030).
      (r) =>
        r.phone ? (
          <>
            Телефон: <PhoneLink phone={r.phone} />
          </>
        ) : (
          <Typography.Text type="secondary">Телефон не указан</Typography.Text>
        ),
      // Должность — до документов: ею объясняется, какую бумагу у человека спрашивают, и без неё
      // «нет УТМ» на карточке машиниста читается как ошибка портала.
      (r) => (r.jobTitle ? `Должность: ${r.jobTitle}` : null),
      ...documentCardLines(visibleTypes),
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
          // Поле одно, а ищет по всему, что видно в карточке: подсказка перечисляет то же, что
          // разбирает сервер, — иначе по номеру телефона его пробуют и не пробуют.
          placeholder: 'ФИО, СНИЛС или контакты',
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
          // Кадровая выгрузка файлом переехала в «Администрирование → Обмен справочниками»
          // (ADR 0073): формат теперь один на все справочники, и вход у него один. Здесь остаётся
          // заведение по одному — им пользуется тот же диспетчер, у которого прав на обмен нет.
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Добавить водителя
          </Button>
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
          <PhoneField />
          <Form.Item
            name="email"
            label="Email"
            // Проверка по уходу из поля, как у телефона: по мере набора адрес невалиден почти
            // всегда, и красное поле во время ввода ничего не сообщает.
            validateTrigger="onBlur"
            rules={[
              () => ({
                validator: (_: unknown, value: unknown) =>
                  optionalEmailSchema.safeParse(typeof value === 'string' ? value : '').success
                    ? Promise.resolve()
                    : Promise.reject(new Error(EMAIL_FORMAT_MESSAGE)),
              }),
            ]}
            extra="На него уходит задание на рейс; пусто — письма водителю не отправляются"
          >
            <Input placeholder="ivanov@example.ru" autoComplete="off" />
          </Form.Item>
          <Form.Item name="comment" label="Комментарий">
            <Input.TextArea rows={2} />
          </Form.Item>

          {record &&
            CREDENTIAL_TYPE_CODES.map((type) => documentsBlock(record, type, documentActions))}

          {!record && (
            <>
              {/* Новый человек заводится водителем (`createDriverSchema`), и вид документа здесь
                  не спрашивается: должность приходит из кадров, а не из этой формы (ADR 0095).
                  Тракторное заводят вторым шагом — окном «Новое удостоверение» в карточке. */}
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
                <Select mode="multiple" options={driverLicenseOptions} placeholder="B, C, CE" />
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
        <Form
          form={licenseForm}
          layout="vertical"
          onFinish={(v) => licenseMut.mutate(v)}
          {...licenseBlockers.formProps}
        >
          <Typography.Paragraph type="secondary">
            {canDeleteLicense
              ? 'Прежнее удостоверение останется в карточке — по нему объясняются листы прошлых лет. Убрать его нужно, только если его там быть не должно.'
              : 'Прежнее удостоверение останется в карточке: по нему объясняются листы прошлых лет.'}
          </Typography.Paragraph>
          {/* Вид документа — первым полем: им определяются и список категорий ниже, и то, какая
              бумага у человека появится. Подставлен по должности карточки, но не заперт: у
              машиниста автокрана в кадрах стоит водительское (ADR 0095). */}
          <Form.Item label="Вид документа">
            <Select
              value={licenseType}
              onChange={(v: CredentialTypeCode) => {
                setLicenseType(v);
                // Выбранные категории — записи справочника прежнего вида: у нового документа их
                // не существует, и уехали бы они на сервер отказом, а не новой бумагой.
                licenseForm.setFieldValue('categoryIds', []);
              }}
              options={CREDENTIAL_TYPE_CODES.map((code) => ({
                value: code,
                label: credentialTypeLabels[code],
              }))}
            />
          </Form.Item>
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
          {/* Категории обязательны только у водительского: документ без них не открывает ничего.
              У тракторного их в кадровой выгрузке не бывает вовсе, и требовать букву, которой
              неоткуда взяться, значило бы не дать завести документ совсем. */}
          <Form.Item
            name="categoryIds"
            label={`Категории ${credentialTypeShortLabels[licenseType]}`}
            rules={[{ required: licenseType === 'driver_license' }]}
          >
            <Select
              mode="multiple"
              options={licenseCategoryOptions}
              placeholder={licenseType === 'driver_license' ? 'B, C, CE' : 'B, C, D, E'}
            />
          </Form.Item>
          {/* Галочка — только администратору и только когда снимать есть что: у карточки без
              документа этого вида она обещала бы действие, которого не произойдёт.

              Нужна она ровно там, где история мешает: переоформленный документ сплошь и рядом
              приходит с той же серией и номером, а их держит прежняя запись — без снятия замена
              упирается в занятый номер. */}
          {canDeleteLicense && previousOfType.length > 0 && (
            <Form.Item name="deletePrevious" valuePropName="checked">
              <Checkbox>
                Убрать прежнее {credentialTypeShortLabels[licenseType]} (
                {previousOfType.map((l) => licenseNumberLabel(l)).join(', ')}) из карточки
              </Checkbox>
            </Form.Item>
          )}
        </Form>
      </FormModal>
    </PageTableLayout>
  );
}
