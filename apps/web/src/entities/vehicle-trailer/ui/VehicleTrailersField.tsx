import { useQuery } from '@tanstack/react-query';
import { Form, Space, Tag, Typography } from 'antd';
import {
  trailerTitle,
  type VehicleDto,
  type VehicleTrailerDto,
  vehicleStatusColors,
  vehicleStatusLabels,
} from '@technic/contracts';
import { trailerSlotsQuery } from '../api/queries';

/**
 * Что закреплено за машиной — в её же карточке (план `docs/vehicle-trailers-plan.md`, §7, шаг 4:
 * «привязка в карточках прицепа и машины»). Обратной видимости не было вовсе: человек, открывший
 * машину, не знал, что за ней стоит полуприцеп, — хотя это её выезды.
 *
 * **Показ, и только.** Прицепляют и отцепляют в карточке прицепа (§4.2): привязка живёт у прицепа,
 * а не у машины, и вторая дверь к одному инварианту означала бы два места, где его чинят порознь.
 * Поэтому здесь нет ни кнопок, ни поля формы — у блока нет `name`, и в тело правки он не попадает.
 *
 * В слое сущности, а не у вкладки справочника: состав машины спрашивает уже окно привязки, а после
 * шага 4 плана спросит и подстановка в рейс, — три описания одного списка разъехались бы при
 * первой правке.
 */
export function VehicleTrailersField({ vehicle }: { vehicle: VehicleDto | null }) {
  /*
   * Кому блок положен — то же правило, по которому машина попадает в список окна привязки
   * (§4.2.3): собственная и с бланком, где графы прицепа есть; у формы № 3 их нет вовсе (ADR 0071),
   * и «прицепов нет» на карточке легкового читалось бы как «пока не прицепили». `null` — карточку
   * ещё не открыли или заводят новую машину: привязок у неё нет по построению.
   *
   * Правило здесь, а не у вкладки техники: оно про прицепы, и написанное вторым местом оно
   * разойдётся с первым — ровно так, как уже случилось с перечнем окон рейса (§4.2.2).
   */
  const vehicleId =
    vehicle && vehicle.ownership === 'own' && vehicle.waybillFormCode !== 'leg3'
      ? vehicle.id
      : undefined;
  const { data, isPending, isError } = useQuery(trailerSlotsQuery(vehicleId));
  if (!vehicleId) return null;

  /*
   * Порядок — по слотам, а не по времени заведения: слот это место в шапке бланка 4-П, и «Прицеп 2»
   * над «Прицепом 1» человек читает как ошибку. Расставляет показ, а не сервер: список справочника
   * сортируется своим `createdAt`, а строк здесь не больше двух — уникальность слота их и держит.
   */
  const trailers = [...(data?.items ?? [])].sort(
    (a, b) => (a.hitchPosition ?? 0) - (b.hitchPosition ?? 0),
  );

  /*
   * Прицеп в обслуживании закреплён законно — он физически стоит за машиной и ждёт ремонта
   * (§4.2.3), — но выезд с ним планируют осознанно. Поэтому состояние видно дважды: меткой в
   * строке (её же цветами, что в реестре) и словами под списком. Одной метки мало: цвет объясняет
   * не всякому, а на телефоне подсказку ещё надо догадаться нажать.
   */
  const inMaintenance = trailers.some((t) => t.status === 'maintenance');
  const whereHitched = 'Прицепляют и отцепляют в карточке прицепа — вкладка «Прицепы»';

  return (
    <Form.Item
      label="Прицепы за машиной"
      extra={
        inMaintenance
          ? `Прицеп в обслуживании закреплён законно, но выезд с ним планируют осознанно. ${whereHitched}`
          : whereHitched
      }
    >
      <TrailerSlotList trailers={trailers} isPending={isPending} isError={isError} />
    </Form.Item>
  );
}

/** Три состояния ответа и сам список: ветками, а не одной строкой с прочерком. */
function TrailerSlotList({
  trailers,
  isPending,
  isError,
}: {
  trailers: VehicleTrailerDto[];
  isPending: boolean;
  isError: boolean;
}) {
  // Ошибку не глотаем: «прицепов нет» и «спросить не вышло» — разные ответы, и молчаливый прочерк
  // на месте второго читался бы как первый.
  if (isError)
    return <Typography.Text type="danger">Не удалось узнать про прицепы</Typography.Text>;
  if (isPending) return <Typography.Text type="secondary">Спрашиваем…</Typography.Text>;
  if (trailers.length === 0)
    return <Typography.Text type="secondary">Прицепов за машиной нет</Typography.Text>;

  return (
    <Space direction="vertical" size={2}>
      {trailers.map((t) => (
        <Space key={t.id} size={8} wrap>
          {/* Слот — не порядок в списке, а пара граф бланка: «Прицеп 2» печатается своей. */}
          <Tag style={{ marginInlineEnd: 0 }}>Прицеп {t.hitchPosition}</Tag>
          {/* Марка и госномер одной подписью — той же, какой прицеп зовут в реестре, в тостах и
              под графами рейса (`trailerTitle`): человек обязан узнать здесь то, что видел там. */}
          <span>{trailerTitle(t)}</span>
          {/* Рабочее состояние молчит: гори метка у каждой строки — среди них не заметить ту одну,
              что в ремонте. Списанного прицепа за машиной не бывает вовсе (CHECK базы). */}
          {t.status === 'active' ? null : (
            <Tag color={vehicleStatusColors[t.status]} style={{ marginInlineEnd: 0 }}>
              {vehicleStatusLabels[t.status]}
            </Tag>
          )}
        </Space>
      ))}
    </Space>
  );
}
