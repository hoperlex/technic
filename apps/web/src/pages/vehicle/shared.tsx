import { useState, type ReactNode } from 'react';
import { App, Button, Dropdown, Form, Input, Select, Tag, Tooltip, Typography, Upload } from 'antd';
import {
  CheckCircleOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  DownOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  allowedVehicleRequestTransitions,
  isApprovalChangeable,
  isPlaceScopedRole,
  parseVehicleClassificationKey,
  type RequestStatus,
  requestStatusColors,
  requestStatusLabels,
  type RequestVehicleEarlyEndInput,
  type SpecialEquipmentRequestDto,
  vehicleClassificationKey,
  type VehicleRequestDto,
  type VehicleRequestEarlyEndDto,
} from '@technic/contracts';
import { filesApi, vehicleRequestsApi } from '../../api/resources';
import {
  useVehicleClassifications,
  type VehicleClassificationGroup,
  type VehicleClassificationOption,
} from '../../hooks/useVehicleClassifications';
import { ActionSheet } from '@shared/ui';
import { AutoSelect } from '@shared/ui';
import { ExpandableCell } from '@shared/ui';
import { FileLinkList } from '../../components/FileLinks';
import { PhoneLink } from '../../components/PhoneField';
import type { FilterDefinition } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTime } from '../../utils/format';
import { objectsApi, objectKeys } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';

export const FILE_MAX_COUNT = 20;
export const FILE_MAX_SIZE = 52_428_800; // 50 МБ

/**
 * Дата без времени (`YYYY-MM-DD`) — как есть, без пересчёта часовых поясов: часа в ней нет,
 * а перевод в МСК из браузера восточнее Москвы сдвинул бы срок спецтехники на день назад.
 */
export function formatDateOnly(value: string): string {
  const [y, m, d] = value.split('-');
  return y && m && d ? `${d}.${m}.${y}` : value;
}

export interface EditorFile {
  id: string;
  filename: string;
  /** Нужен ссылке в списке: фото и PDF открываются окном просмотра, остальное скачивается. */
  contentType: string;
  size: number;
  isNew: boolean;
}

/** Опции активных объектов для Select (грузятся разом, pageSize=500). */
export function useObjectOptions() {
  const { data, isFetching } = useQuery({
    queryKey: objectKeys.options({ activeOnly: true }),
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  return {
    options: (data?.items ?? []).map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` })),
    loading: isFetching,
  };
}

/**
 * Отделы для выбора (ADR 0040) — второй заказчик рядом с объектами. Неактивные не показываются:
 * заявку заводят на действующее подразделение, а у заведённых наименование приходит с заявкой.
 */
export function useDepartmentOptions() {
  const { data, isFetching } = useQuery(departmentOptionsQuery());
  return { options: data ?? [], loading: isFetching };
}

/**
 * Фильтр по заказанной технике — общий для списка заявок и журнала: вопрос «какую технику
 * заказывали» в них один и тот же.
 *
 * Один список на оба уровня, а не «тип, затем категория» двумя полями: выбор и в форме заявки
 * один (ADR 0028), и в фильтре читается так же — «Автокраны — все категории» рядом с «Автокраны,
 * г/п 130 т». Каскад из двух полей стоил бы двух касаний в шите на телефоне (ADR 0030), где
 * второе поле появлялось бы только после «Применить».
 *
 * Список не сужается выбранным типом заявки: фильтры независимы, а пустой результат
 * («грузоперевозка автокраном») читается сам.
 */
export function useVehicleClassificationFilter({
  vehicleTypeId,
  vehicleCategoryId,
  onChange,
}: {
  vehicleTypeId: string | undefined;
  vehicleCategoryId: string | undefined;
  /** В параметры списка уходит пара полей: ключ позиции — только вид выбора, не запрос. */
  onChange: (patch: { vehicleTypeId?: string; vehicleCategoryId?: string }) => void;
}): { controls: ReactNode; mobileFilter: FilterDefinition } {
  const { filterGroups, loading } = useVehicleClassifications();
  const value = vehicleTypeId
    ? vehicleClassificationKey(vehicleTypeId, vehicleCategoryId)
    : undefined;
  const pick = (key: string | undefined) => {
    const picked = parseVehicleClassificationKey(key);
    onChange({
      vehicleTypeId: picked?.vehicleTypeId,
      vehicleCategoryId: picked?.vehicleCategoryId ?? undefined,
    });
  };

  const controls = (
    <Select
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder="Вся техника"
      style={{ width: 250 }}
      options={filterGroups}
      loading={loading}
      value={value}
      onChange={pick}
    />
  );

  /** Тот же фильтр описанием — для шита на телефоне (ADR 0030). */
  const mobileFilter: FilterDefinition = {
    kind: 'select',
    key: 'classification',
    label: 'Тип/категория ТС',
    value,
    options: filterGroups,
    placeholder: 'Вся техника',
    loading,
    onChange: pick,
  };

  return { controls, mobileFilter };
}

/** Редактор прикреплённых файлов (загрузка в S3 + список add/remove). */
export function useFileEditor() {
  const { message } = App.useApp();
  const [files, setFiles] = useState<EditorFile[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const reset = (initial: EditorFile[] = []) => {
    setFiles(initial);
    setRemovedIds([]);
  };
  const upload = async (file: File) => {
    if (files.length >= FILE_MAX_COUNT) {
      message.error(`Не более ${FILE_MAX_COUNT} файлов`);
      return;
    }
    if (file.size > FILE_MAX_SIZE) {
      message.error('Файл больше 50 МБ');
      return;
    }
    setUploading(true);
    try {
      const dto = await filesApi.upload(file);
      setFiles((p) => [
        ...p,
        {
          id: dto.id,
          filename: dto.filename,
          contentType: dto.contentType,
          size: dto.size,
          isNew: true,
        },
      ]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };
  const remove = (id: string) => {
    const f = files.find((x) => x.id === id);
    setFiles((p) => p.filter((x) => x.id !== id));
    if (!f) return;
    if (f.isNew) void filesApi.remove(id).catch(() => undefined);
    else setRemovedIds((p) => [...p, id]);
  };
  const newFileIds = () => files.filter((f) => f.isNew).map((f) => f.id);

  return { files, removedIds, uploading, reset, upload, remove, newFileIds };
}

export function FileEditor({ editor }: { editor: ReturnType<typeof useFileEditor> }) {
  return (
    <div>
      <Upload
        multiple
        showUploadList={false}
        beforeUpload={(f) => {
          void editor.upload(f);
          return false;
        }}
      >
        <Button icon={<UploadOutlined />} loading={editor.uploading}>
          Прикрепить файлы
        </Button>
      </Upload>
      <div style={{ marginTop: 8 }}>
        <FileLinkList
          files={editor.files}
          emptyText="Нет файлов"
          onRemove={(f) => editor.remove(f.id)}
        />
      </div>
    </div>
  );
}

/** Ячейка статуса: дропдаун доступных роли переходов либо тег. */
export function StatusCell({
  status,
  deleted,
  approved,
  cancelReason,
  pending,
  onChange,
}: {
  status: RequestStatus;
  deleted: boolean;
  /** Виза руководителя строительства: без неё заявку не берут в работу (ADR 0025). */
  approved: boolean;
  /** Причина отмены — подсказкой на теге (колонки под неё в таблице нет). */
  cancelReason?: string | null;
  pending: boolean;
  onChange: (s: RequestStatus) => void;
}) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  // Линейный цикл доступен ведущим заявки ролям, откаты закрытых заявок — только админу;
  // «В работе» до визы не предлагается никому — сервер такой переход отклонит.
  const transitions = user ? allowedVehicleRequestTransitions(status, user, approved) : [];
  const plain = <Tag color={requestStatusColors[status]}>{requestStatusLabels[status]}</Tag>;
  // Причина отмены — подсказкой только на десктопе: на телефоне подсказка по касанию не
  // открывается, и причина выводится строкой карточки (ADR 0030).
  const tag =
    cancelReason && !isMobile ? (
      <Tooltip title={`Причина отмены: ${cancelReason}`}>{plain}</Tooltip>
    ) : (
      plain
    );
  if (deleted || transitions.length === 0) return tag;

  // На телефоне переходы показываются списком снизу: выпадающее меню открывается под палец
  // мимо цели, а нажатие по тегу не должно заодно открывать карточку заявки.
  if (isMobile) {
    return (
      <>
        <button
          type="button"
          className="status-trigger"
          aria-label="Изменить статус"
          disabled={pending}
          onClick={(e) => {
            e.stopPropagation();
            setSheetOpen(true);
          }}
        >
          {tag}
          <DownOutlined style={{ fontSize: 10, color: 'rgba(0,0,0,0.45)' }} />
        </button>
        <ActionSheet
          title="Изменить статус"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          items={transitions.map((s) => ({
            key: s,
            label: requestStatusLabels[s],
            onClick: () => onChange(s),
          }))}
        />
      </>
    );
  }

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: transitions.map((s) => ({ key: s, label: requestStatusLabels[s] })),
        onClick: ({ key }) => onChange(key as RequestStatus),
      }}
    >
      <Button size="small" type="text" loading={pending}>
        {tag}
        <DownOutlined />
      </Button>
    </Dropdown>
  );
}

/**
 * Ячейка согласования (ADR 0025). Завизированная заявка — зелёная с галочкой, ждущая визы —
 * оранжевая: состояние читается цветом, не текстом, потому что в списке это первое, на что
 * смотрят и диспетчер, и руководитель строительства.
 *
 * Кнопкой ячейка становится только у того, кто эту заявку визирует, и только пока её не взяли
 * в работу; остальным и в остальных статусах — тег.
 */
export function ApprovalCell({
  status,
  deleted,
  approved,
  approvedByName,
  approvedAt,
  canApprove,
  pending,
  onChange,
}: {
  status: RequestStatus;
  deleted: boolean;
  approved: boolean;
  approvedByName: string | null;
  approvedAt: string | null;
  /** Право визы у роли; чужой объект сервер отсечёт сам (assertObjectScope). */
  canApprove: boolean;
  pending: boolean;
  onChange: (approved: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const approvedTitle =
    approved && approvedAt
      ? `Завизировал ${approvedByName ?? '—'} · ${formatDateTime(approvedAt)}`
      : 'Заявка ждёт визы руководителя строительства';
  const editable = canApprove && !deleted && isApprovalChangeable(status);

  if (!editable) {
    const tag = approved ? (
      <Tag color="green" icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
        Завизирована
      </Tag>
    ) : (
      <Tag color="orange" icon={<ClockCircleOutlined />} style={{ marginInlineEnd: 0 }}>
        Ждёт визы
      </Tag>
    );
    // На телефоне подсказки нет: кто и когда завизировал, видно в карточке заявки.
    return isMobile ? tag : <Tooltip title={approvedTitle}>{tag}</Tooltip>;
  }

  const button = (
    <Button
      size="small"
      color={approved ? 'green' : 'orange'}
      variant="solid"
      loading={pending}
      icon={approved ? <CheckOutlined /> : undefined}
      // Виза стоит внутри карточки списка: нажатие на неё не должно открывать саму карточку.
      onClick={(e) => {
        e.stopPropagation();
        onChange(!approved);
      }}
    >
      {approved ? 'Завизирована' : 'Согласовать'}
    </Button>
  );

  return isMobile ? (
    button
  ) : (
    <Tooltip
      title={approved ? `${approvedTitle}. Нажмите, чтобы снять визу` : 'Согласовать заявку'}
    >
      {button}
    </Tooltip>
  );
}

/** Контакт заявки: чья это роль, кто им занят, куда ехать и по какому номеру звонить. */
interface RequestContact {
  role: string;
  name: string;
  phone: string;
  /** Адрес, к которому контакт приставлен; `null` — у объекта он не заполнен (поле необязательное). */
  address: string | null;
}

/**
 * Контакты заявки по местам работы. У заказа техники на объект контакт один — тот, кто встречает
 * технику на площадке, и адрес у него объектный; у грузоперевозки их два, по одному на конец
 * маршрута, и у каждого свой адрес: грузят и принимают разные люди в разных местах.
 *
 * Роль в паре с именем неотделима намеренно: «Иванов» без роли в списке ничего не значит — звонить
 * по нему будут не зная, о каком конце маршрута спрашивать.
 */
export function requestContacts(r: VehicleRequestDto): RequestContact[] {
  const contacts: RequestContact[] =
    r.requestType === 'special_equipment'
      ? [
          {
            role: 'Отв. на объекте',
            name: r.responsibleName,
            phone: r.responsiblePhone,
            address: r.objectAddress,
          },
        ]
      : [
          {
            role: 'Отв. за погрузку',
            name: r.loadingResponsibleName,
            phone: r.loadingResponsiblePhone,
            address: r.loadingLocation,
          },
          {
            role: 'Отв. за разгрузку',
            name: r.unloadingResponsibleName,
            phone: r.unloadingResponsiblePhone,
            address: r.unloadingLocation,
          },
        ];
  // Пустой контакт не занимает строку: у заявок до миграции 0062 его нет вовсе, и «Отв. за
  // погрузку —» сообщал бы о заявке ровно ничего, отнимая у соседнего контакта видимую строку.
  return contacts.filter((c) => c.name || c.phone || c.address);
}

/**
 * Контакты в строке списка: роль с именем, под ними адрес и телефон. Отвечает на «кому звонить и
 * куда ехать» — второй вопрос к списку заявок после самой заявки, и до сих пор за ответом
 * приходилось открывать карточку каждой.
 *
 * Ячейка сворачивается (`ExpandableCell`): у грузоперевозки контактов два, адреса длинные, и
 * пущенные в высоту они растянули бы каждую строку списка на пять-шесть строк текста.
 */
export function RequestContactsCell({ request }: { request: VehicleRequestDto }) {
  const contacts = requestContacts(request);
  if (contacts.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <ExpandableCell>
      {contacts.map((c, i) => (
        <div key={c.role} style={{ marginTop: i === 0 ? 0 : 4 }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {c.role}
            </Typography.Text>{' '}
            {c.name || '—'}
          </div>
          <div style={{ fontSize: 12 }}>
            {c.address && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }} title={c.address}>
                {c.address}
              </Typography.Text>
            )}
            {c.address && c.phone ? ' · ' : null}
            {/* Номер ссылкой `tel:`: по контакту в списке именно звонят (ADR 0066). */}
            {c.phone && <PhoneLink phone={c.phone} />}
          </div>
        </div>
      ))}
    </ExpandableCell>
  );
}

/**
 * Выбор заказываемой техники (ADR 0028): одна позиция классификатора — категория типа
 * («Автокраны, г/п 130 т») либо сам тип, если ТТХ у него нет («Ямобур»). Список сгруппирован по
 * виду ТС и сужен типом заявки, поэтому до его выбора поле недоступно. В форме лежит ключ
 * позиции, в API уходит пара «тип + категория».
 *
 * Справа от наименования — порядок цены позиции: средняя ставка её техники. Приписка живёт только
 * в раскрытом списке (`optionRender`): поиск идёт по наименованию, и выбранная позиция называется
 * им же — цена в свёрнутом поле читалась бы как согласованная ставка, а она справочная.
 */
export function VehicleClassificationSelect({
  groups,
  loading,
  disabled,
  placeholder = 'Выберите тип или категорию',
}: {
  groups: VehicleClassificationGroup[];
  loading: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Form.Item
      name="classificationKey"
      label="Тип/категория ТС"
      tooltip="У типа с характеристиками выбирают категорию — «Автокран, г/п 130 т»; тип без характеристик выбирается целиком. Список сужен типом заявки: грузоперевозку выполняет только грузовая техника"
      rules={[{ required: true, message: 'Выберите тип или категорию' }]}
    >
      <AutoSelect
        options={groups}
        showSearch
        optionFilterProp="label"
        loading={loading}
        disabled={disabled}
        placeholder={placeholder}
        optionRender={(option) => {
          const hint = (option.data as VehicleClassificationOption).priceHint;
          if (!hint) return option.label;
          return (
            <div className="option-row">
              <span className="option-row__label">{option.label}</span>
              <Typography.Text type="secondary" className="option-row__hint">
                {hint}
              </Typography.Text>
            </div>
          );
        }}
      />
    </Form.Item>
  );
}

/**
 * Досрочное завершение в строке списка (ADR 0044): ожидание визы — оранжевым, состоявшееся
 * сокращение — серой припиской «срок сокращён с …».
 *
 * Ожидающий визы запрос показывается везде, где видно заявку: пока визы нет, срок в строке
 * прежний, и без тега площадка узнавала бы об отъезде техники в день отъезда. Отклонённый
 * запрос в списке не показывается — заявка живёт по заказанному сроку, и объяснение к этому
 * лежит в карточке.
 */
export function EarlyEndTag({ earlyEnd }: { earlyEnd: VehicleRequestEarlyEndDto | null }) {
  if (!earlyEnd || earlyEnd.status === 'rejected') return null;
  if (earlyEnd.status === 'pending') {
    return (
      <Tooltip title={`Запросил ${earlyEnd.requestedByName}: ${earlyEnd.reason}`}>
        <Tag color="orange" style={{ marginInlineEnd: 0 }}>
          досрочно до {formatDateOnly(earlyEnd.newDateTo)} · ждёт визы
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      срок сокращён с {formatDateOnly(earlyEnd.previousDateTo)}
    </Typography.Text>
  );
}

/**
 * Действия досрочного завершения — одни на обе вкладки заказа ТС: запрос сокращения, решение по
 * нему и отзыв. Хук держит и окно запроса, и мутации: вкладки различаются тем, как показывают
 * заявки, а не тем, как их ведут, — разъедься эти действия по двум файлам, они разошлись бы и по
 * поведению (в одном месте спрашивали бы подтверждение отказа, в другом нет).
 */
export function useEarlyEnd() {
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const [target, setTarget] = useState<SpecialEquipmentRequestDto | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });

  const requestMut = useMutation({
    mutationFn: (v: { id: string; body: RequestVehicleEarlyEndInput }) =>
      vehicleRequestsApi.requestEarlyEnd(v.id, v.body),
    onSuccess: (res) => {
      // Сообщение называет то, что произошло на самом деле: запрос визирующего сервер применяет
      // сразу, и «отправлено на визу» было бы неправдой.
      const applied =
        res.requestType === 'special_equipment' && res.earlyEnd?.status === 'approved';
      message.success(applied ? 'Срок заявки сокращён' : 'Запрос отправлен на визу');
      setTarget(null);
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const decideMut = useMutation({
    mutationFn: (v: { id: string; approved: boolean; version: number; comment?: string }) =>
      vehicleRequestsApi.decideEarlyEnd(v.id, v.approved, v.version, v.comment ?? ''),
    onSuccess: (_res, v) => {
      message.success(v.approved ? 'Досрочное завершение согласовано' : 'Запрос отклонён');
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => vehicleRequestsApi.cancelEarlyEnd(id),
    onSuccess: () => {
      message.success('Запрос отозван');
      invalidate();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Своя виза применяется сразу — тем же правилом, что и при заведении заявки (ADR 0032). */
  const approvesOwn = isPlaceScopedRole(user?.role ?? null) && can('vehicleRequests.approve');

  /** Отказ спрашивает причину: заявка остаётся на заказанном сроке, и это надо объяснить. */
  const reject = (r: VehicleRequestDto) => {
    let reason = '';
    modal.confirm({
      title: `Отклонить досрочное завершение ${r.displayNumber}?`,
      content: (
        <Input.TextArea
          rows={2}
          maxLength={2000}
          placeholder="Причина отказа: например, техника ещё нужна на объекте"
          onChange={(e) => {
            reason = e.target.value;
          }}
        />
      ),
      okText: 'Отклонить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        if (!reason.trim()) {
          message.warning('Укажите причину отказа');
          throw new Error('reason required');
        }
        await decideMut.mutateAsync({
          id: r.id,
          approved: false,
          version: r.version,
          comment: reason.trim(),
        });
      },
    });
  };

  const withdraw = (r: VehicleRequestDto) =>
    modal.confirm({
      title: `Отозвать запрос на досрочное завершение ${r.displayNumber}?`,
      content: 'Срок заявки останется прежним.',
      okText: 'Отозвать',
      cancelText: 'Отмена',
      onOk: () => cancelMut.mutateAsync(r.id),
    });

  return {
    /** Заявка, для которой открыто окно запроса. */
    target,
    open: setTarget,
    close: () => setTarget(null),
    approvesOwn,
    submit: (body: RequestVehicleEarlyEndInput) => {
      if (target) requestMut.mutate({ id: target.id, body });
    },
    approve: (r: VehicleRequestDto) =>
      decideMut.mutate({ id: r.id, approved: true, version: r.version }),
    reject,
    withdraw,
    pending: requestMut.isPending || decideMut.isPending || cancelMut.isPending,
  };
}
