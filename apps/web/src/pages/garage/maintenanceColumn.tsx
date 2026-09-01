import { useMemo, type ReactNode } from 'react';
import { Space, Tag, Typography, type TableColumnType } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  maintenanceStateColors,
  maintenanceStateHint,
  maintenanceStateLabels,
  type VehicleMaintenanceSummaryDto,
} from '@technic/contracts';
import { vehicleMaintenanceApi, vehicleMaintenanceKeys } from '@entities/vehicle-maintenance';
import { useMaintenanceAddress, VehicleMaintenanceModal } from '@features/vehicle-maintenance';
import { EntityLink, type ActionSheetItem } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';

/**
 * Колонка «ТО» вкладки «Техника» и вход механика в сводку обслуживания (план «Показания техники»,
 * Р12—Р16, Р24).
 *
 * **Состояние приходит пакетом на страницу, а не по строке.** Одна ручка `snapshot` со списком
 * машин видимой страницы: расчёт пробега с обслуживания идёт по цепочке показаний, и полсотни
 * отдельных запросов из строк открывали бы срез дня заметно дольше, чем он открывается сейчас.
 * Тем же приёмом сервер считает занятость и состояние показаний — одним ответом на страницу.
 *
 * **День среза — тот же, что у вкладки** (Р16): и записи ТО, и последний одометр берутся не позже
 * него. Срез марта, показавший майское обслуживание, отвечал бы не на тот вопрос, который задали
 * календарём наверху.
 *
 * **Состояние портал не считает** (Р24): `state` приходит посчитанным, красится общим словарём и
 * объясняется общим текстом. Второй формулы здесь нет — иначе «9 500 км со сброшенным счётчиком»
 * читалось бы в колонке как «скоро ТО», а в блоке карточки как «неизвестно» (Р11в).
 *
 * **Открытая машина названа в адресе** — общим для обоих входов ключом (`useMaintenanceAddress`,
 * Р14в, Р29): ссылку отправляют коллеге, «назад» закрывает окно, перезагрузка оставляет его
 * открытым.
 *
 * Отдельным файлом, а не строками в `GarageVehiclesTab.tsx`: у вкладки бюджет длины
 * (`quality-budget.json`), и запрос с окном в него не помещались.
 */

const SHOWN_DATE = 'DD.MM.YYYY';

/** Что колонке нужно от строки: остальное — дело вкладки, у которой свой тип среза. */
interface MaintenanceRow {
  id: string;
  label: string;
}

/**
 * Подпись машины в заголовке окна. Обычно берётся из строки, по которой кликнули; присланная
 * ссылка может назвать машину с другой страницы списка — тогда сводка всё равно открывается и
 * грузится по идентификатору из адреса, а имени у окна до ответа нет.
 */
function openedVehicle<T extends MaintenanceRow>(id: string, rows: T[]) {
  return { id, label: rows.find((r) => r.id === id)?.label ?? 'машина' };
}

/** Ячейка: состояние тегом, дата последнего акта под ним и вход в сводку (Р14в). */
function cell(summary: VehicleMaintenanceSummaryDto, href: string): ReactNode {
  const hint = maintenanceStateHint(summary);
  const last = summary.lastMaintenance;
  return (
    <Space orientation="vertical" size={2} align="start">
      {/* Объяснение — на самом теге: в колонку оно не помещается, а «неизвестно» без него
          читается как поломка портала, хотя означает две разные вещи (Р11в). */}
      <span title={hint}>
        <Tag color={maintenanceStateColors[summary.state]} style={{ marginInlineEnd: 0 }}>
          {maintenanceStateLabels[summary.state]}
        </Tag>
      </span>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {last ? dayjs(last.performedOn).format(SHOWN_DATE) : 'записей нет'}
      </Typography.Text>
      <EntityLink to={href} title="Открыть сводку обслуживания">
        сводка
      </EntityLink>
    </Space>
  );
}

/**
 * Колонка «ТО», строка карточки телефона, пункт её действий и окно сводки — одним хуком: у всех
 * четверых один источник (пакетный ответ на страницу) и один адрес открытой машины.
 */
export function useMaintenanceColumn<T extends MaintenanceRow>({
  date,
  rows,
}: {
  /** День среза вкладки: он же уходит в `on` (Р16). */
  date: string;
  /** Машины видимой страницы — ровно те, про которые спрашивается состояние. */
  rows: T[];
}): {
  /** Готова к раскрытию в список колонок: без права на ТО он пуст — колонки нет вовсе. */
  columns: TableColumnType<T>[];
  cardLine: (row: T) => ReactNode;
  cardActions: (row: T) => ActionSheetItem[];
  /** Окно сводки: рисуется один раз рядом со списком, а не в каждой строке. */
  modal: ReactNode;
} {
  const { can } = useAuth();
  /*
   * Право своё и самодостаточное (Р14): без него ни колонки, ни запроса. Не «колонка с
   * прочерками» — столбец пустоты означал бы «обслуживания за парком не числится», то есть
   * неправду; и не «ответ, из которого сервер вырезал поля» — право, влияющее на состав чужого
   * DTO, это то же смешение, только спрятанное в сериализатор (Р14а).
   */
  const allowed = can('vehicleMaintenance.read');
  /*
   * Открытая машина названа в адресе (`?tab=vehicles&maintenance=<id>`, Р14в, Р29), и тем же ключом
   * её называет справочник техники: окно у обоих входов одно, и второе имя означало бы, что ссылки
   * из гаража и из справочника открывают разные вещи.
   */
  const address = useMaintenanceAddress(allowed);

  const ids = rows.map((r) => r.id).join(',');
  const query = { on: date, ids };
  const { data } = useQuery({
    queryKey: vehicleMaintenanceKeys.snapshot(query),
    queryFn: () => vehicleMaintenanceApi.snapshot(query),
    // Пустая страница спрашивать нечего: список ещё грузится либо отбор не дал ни одной машины.
    enabled: allowed && ids !== '',
  });

  const byId = useMemo(
    () => new Map((data?.items ?? []).map((item) => [item.vehicleId, item])),
    [data],
  );

  const column: TableColumnType<T> = {
    key: 'maintenance',
    title: 'ТО',
    width: 150,
    // Сортировки нет намеренно, как и у одометра: сервер сортирует парк своими полями
    // (`GARAGE_VEHICLE_SORT_FIELDS`), а состояние ТО среди них не значится — заголовок, который
    // сервер не слышит, обещал бы порядок, которого не случится.
    render: (_v, r) => {
      const summary = byId.get(r.id);
      /*
       * Прочерк молчит в двух случаях: ответ ещё не пришёл и ТО по этому типу техники не ведётся
       * (Р13). Второй — норма справочника, а не тревога: тег «не ведётся» в каждой строке легковых
       * и прицепов кричал бы о том, о чём вопроса нет. Почему прочерк — объясняет подсказка.
       */
      if (!summary || summary.state === 'not_tracked') {
        return (
          <Typography.Text type="secondary" title={summary && maintenanceStateHint(summary)}>
            —
          </Typography.Text>
        );
      }
      return cell(summary, address.href(r.id));
    },
  };

  return {
    columns: allowed ? [column] : [],
    /**
     * Строка карточки телефона: «ТО: просрочено (10.06.2026)». Пусто — состояния нет либо ТО не
     * ведётся: в обоих случаях карточка молчит, а не показывает прочерк, — тем же живёт одометр.
     */
    cardLine: (row) => {
      const summary = byId.get(row.id);
      if (!summary || summary.state === 'not_tracked') return null;
      const last = summary.lastMaintenance;
      const when = last ? ` (${dayjs(last.performedOn).format(SHOWN_DATE)})` : '';
      return `ТО: ${maintenanceStateLabels[summary.state]}${when}`;
    },
    /**
     * Вход в сводку на телефоне: пунктом в действиях строки, а не ссылкой в карточке (ADR 0030).
     * Касание по самой карточке уже занято журналом показаний у тех, кому он положен, а у механика
     * карточка не открывается вовсе — второго смысла у касания быть не должно.
     */
    cardActions: (row) =>
      allowed
        ? [{ key: 'maintenance', label: 'Обслуживание', onClick: () => address.open(row.id) }]
        : [],
    modal: (
      <VehicleMaintenanceModal
        vehicle={address.id ? openedVehicle(address.id, rows) : null}
        on={date}
        onClose={address.close}
      />
    ),
  };
}
