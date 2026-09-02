import { useMemo, type ReactNode } from 'react';
import { Space, Typography, type TableColumnType } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { autoPartReceiptApi, autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { EntityLink, type ActionSheetItem } from '@shared/ui';
import { useActiveTabKey } from '../../components/PageTabs';
import { useAuth } from '../../auth/AuthContext';
import { formatMoney } from '../../utils/format';
import { useVehicleSpendAddress } from './receiptsAddress';
import { VehiclePartsSpendModal } from './VehiclePartsSpendModal';

/**
 * Колонка «Запчасти, ₽» вкладки «Техника» и вход в окно «Запчасти машины» (план
 * `docs/auto-part-receipts-plan.md`, Р14, Р15).
 *
 * **Суммы приходят пакетом на страницу, а не по строке.** Приём целиком из колонки «ТО»
 * (`maintenanceColumn.tsx`): одна ручка снапшота со списком машин видимой страницы. Полсотни
 * запросов из строк открывали бы срез дня заметно дольше, чем он открывается сейчас, — а ответ
 * при этом тот же.
 *
 * **День среза — тот же, что у вкладки** (Р14): в сумму идут чеки не позже него. Срез марта,
 * показавший августовскую покупку, отвечал бы не на тот вопрос, который задали календарём наверху.
 *
 * **Пусто — прочерк, а не «0 ₽»** (Р14, §8). Машина, на которую не тратили, и машина, по которой
 * чеков ещё не завели, — одно и то же незнание, и ноль читался бы как утверждение «на машину не
 * тратили». Сервер такие машины из ответа просто не присылает.
 *
 * **Право — `garage.read`, и своего у колонки нет** (Р5): вопрос «сколько вложено в эту машину»
 * задаёт всякий, кому виден гараж. Показания здесь ни при чём — у механика, которому вкладка
 * «Показания» не видна вовсе, колонка стоит ровно такая же.
 *
 * Отдельным файлом, а не строками в `GarageVehiclesTab.tsx`: у вкладки бюджет длины
 * (`quality-budget.json`), и запрос с окном в него не помещались.
 */

const SHOWN_DATE = 'DD.MM.YYYY';

/** Что колонке нужно от строки: остальное — дело вкладки, у которой свой тип среза. */
interface SpendRow {
  id: string;
  label: string;
}

/**
 * Подпись машины в заголовке окна. Обычно берётся из строки, по которой нажали; присланная ссылка
 * может назвать машину с другой страницы списка — тогда окно всё равно открывается и грузится по
 * идентификатору из адреса, а имя ему приходит в ответе.
 */
function openedVehicle<T extends SpendRow>(id: string, rows: T[]) {
  return { id, label: rows.find((r) => r.id === id)?.label };
}

/**
 * Колонка, строка карточки телефона, пункт её действий и окно «Запчасти машины» — одним хуком: у
 * всех четверых один источник (пакетный ответ на страницу) и один адрес открытой машины.
 */
export function usePartsSpendColumn<T extends SpendRow>({
  date,
  rows,
}: {
  /** День среза вкладки: он же уходит в `to` (Р14). */
  date: string;
  /** Машины видимой страницы — ровно те, про которые спрашиваются суммы. */
  rows: T[];
}): {
  /** Готова к раскрытию в список колонок. */
  columns: TableColumnType<T>[];
  cardLine: (row: T) => ReactNode;
  cardActions: (row: T) => ActionSheetItem[];
  /** Окно машины: рисуется один раз рядом со списком, а не в каждой строке. */
  modal: ReactNode;
} {
  const { can } = useAuth();
  const allowed = can('garage.read');
  /*
   * Активную вкладку спрашиваем не ради права, а ради единственности окна: ключ `?spend=` читают
   * трое (Р15), и двое из них — «Техника» и «Автозапчасти» — вкладки одной страницы, которые
   * остаются смонтированными, уйди с них хоть куда (`PageTabs`). Без этой проверки присланная
   * ссылка открывала бы два одинаковых окна друг поверх друга.
   */
  const active = useActiveTabKey() === 'vehicles';
  const address = useVehicleSpendAddress(allowed && active);

  const ids = rows.map((r) => r.id).join(',');
  const query = { to: date, ids };
  const { data } = useQuery({
    queryKey: autoPartReceiptKeys.snapshot(query),
    queryFn: () => autoPartReceiptApi.vehiclesSnapshot(query),
    // Пустую страницу спрашивать нечего: список ещё грузится либо отбор не дал ни одной машины.
    enabled: allowed && ids !== '',
  });

  const byId = useMemo(
    () => new Map((data?.items ?? []).map((item) => [item.vehicleId, item])),
    [data],
  );

  const column: TableColumnType<T> = {
    key: 'partsSpend',
    title: 'Запчасти, ₽',
    width: 150,
    // Сортировки нет намеренно, как и у одометра с колонкой ТО: сервер сортирует парк своими
    // полями (`GARAGE_VEHICLE_SORT_FIELDS`), а суммы чеков среди них не значится — заголовок,
    // который сервер не слышит, обещал бы порядок, которого не случится.
    render: (_v, r) => {
      const spend = byId.get(r.id);
      /*
       * Прочерк молчит про две вещи сразу: ответ ещё не пришёл и покупок за машиной не числится.
       * Обе — незнание, и «0 ₽» на их месте было бы утверждением (Р14). Ссылки в пустой ячейке
       * нет: окно, открытое из неё, показало бы ровно ту же пустоту, — а на телефоне вход в него
       * остаётся пунктом действий, где он ничего не занимает.
       */
      if (!spend) {
        return (
          <Typography.Text type="secondary" title="Покупок за этой машиной не числится">
            —
          </Typography.Text>
        );
      }
      return (
        <Space orientation="vertical" size={2} align="start">
          {/* Сама сумма и есть вход в окно (Р14): нажатие по ней открывает перечень, из которого
              она сложилась. */}
          <EntityLink to={address.href(r.id)} title="Открыть перечень покупок по машине">
            {formatMoney(spend.total)}
          </EntityLink>
          {/* Дата последней покупки обязательна рядом с числом: сумма без неё читается как
              свежая и врёт тем сильнее, чем дольше на машину ничего не покупали. */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {spend.lastPurchasedOn
              ? dayjs(spend.lastPurchasedOn).format(SHOWN_DATE)
              : 'покупок нет'}
          </Typography.Text>
        </Space>
      );
    },
  };

  return {
    columns: allowed ? [column] : [],
    /**
     * Строка карточки телефона: «запчасти: 12 300,00 ₽ (14.08.2026)». Пусто — покупок за машиной
     * не числится: карточка тогда молчит, а не показывает прочерк, — тем же живут одометр и ТО.
     */
    cardLine: (row) => {
      const spend = byId.get(row.id);
      if (!spend) return null;
      const when = spend.lastPurchasedOn
        ? ` (${dayjs(spend.lastPurchasedOn).format(SHOWN_DATE)})`
        : '';
      return `запчасти: ${formatMoney(spend.total)}${when}`;
    },
    /**
     * Вход в окно на телефоне: пунктом в действиях строки, а не ссылкой в карточке (ADR 0030).
     * Касание по самой карточке уже занято журналом показаний у тех, кому он положен, — второго
     * смысла у касания быть не должно.
     *
     * Пункт стоит и у машины без покупок, в отличие от ячейки: список действий от лишней строки
     * не рябит, а «точно ли на неё ничего не покупали» — законный вопрос, на который окно
     * отвечает пустым перечнем.
     */
    cardActions: (row) =>
      allowed
        ? [{ key: 'partsSpend', label: 'Запчасти машины', onClick: () => address.open(row.id) }]
        : [],
    modal: (
      <VehiclePartsSpendModal
        vehicle={address.id ? openedVehicle(address.id, rows) : null}
        /*
         * Окно открывается тем же днём среза, каким посчитана сумма в ячейке: иначе число, по
         * которому нажали, и перечень под ним отвечали бы про разные отрезки. Нижней границы у
         * колонки нет — она считает «всё, что не позже дня среза».
         */
        to={date}
        onClose={address.close}
      />
    ),
  };
}
