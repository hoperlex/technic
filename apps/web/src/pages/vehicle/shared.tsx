import { useState, type ReactNode } from 'react';
import { App, Button, Dropdown, Form, Select, Tag, Tooltip, Typography, Upload } from 'antd';
import {
  CheckCircleOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  DownOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  allowedVehicleRequestTransitions,
  isApprovalChangeable,
  parseVehicleClassificationKey,
  type RequestStatus,
  requestStatusColors,
  requestStatusLabels,
  vehicleClassificationKey,
} from '@technic/contracts';
import { departmentsApi, filesApi, objectsApi } from '../../api/resources';
import {
  useVehicleClassifications,
  type VehicleClassificationGroup,
  type VehicleClassificationOption,
} from '../../hooks/useVehicleClassifications';
import { ActionSheet } from '../../components/ActionSheet';
import { AutoSelect } from '../../components/AutoSelect';
import { FileLinkList } from '../../components/FileLinks';
import type { FilterDefinition } from '../../components/listControls';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTime } from '../../utils/format';

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
    queryKey: ['objects', 'for-select'],
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
  const { data, isFetching } = useQuery({
    queryKey: ['departments', 'for-select'],
    queryFn: () =>
      departmentsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  return {
    options: (data?.items ?? []).map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` })),
    loading: isFetching,
  };
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
