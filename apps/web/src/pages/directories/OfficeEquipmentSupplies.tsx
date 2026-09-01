import { Empty, Space, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { OfficeEquipmentConsumableRefDto } from '@technic/contracts';
import { officeEquipmentApi, officeEquipmentKeys } from '@entities/office-equipment';

/**
 * «Чем заправлять» — расходники, подходящие модели этого аппарата (план
 * `docs/office-equipment-consumables-plan.md`, Р15).
 *
 * Ради этого вопроса карточку аппарата и открывают чаще всего: у стойки стоит человек с пустым
 * принтером, и ему нужен код номенклатуры для заказа и ответ «есть ли на складе прямо сейчас».
 * Искать это в окне картриджей, вспоминая имя модели, — лишний ход по справочнику, который портал
 * и так знает.
 *
 * Данные приходят карточкой с сервера (`GET /office-equipment/:id`), той же, что приносит историю
 * обслуживания, — второго запроса секция не делает. Погашенные позиции сервер сюда не кладёт: их
 * больше не покупают, и звать за ними на пустую полку незачем.
 *
 * Отсутствие поля и пустой список — разные ответы, и различать их обязательно. Поля нет — этот
 * ответ такого среза не содержит (список справочника, старый кэш): сказать по нему «расходников
 * нет» значит соврать, поэтому секция не рисуется вовсе. Пустой массив — это уже утверждение: к
 * модели ничего не привязано, и его показывают словами, потому что дозаполнять номенклатуру идут
 * именно по таким аппаратам.
 */
export function OfficeEquipmentSupplies({ equipmentId }: { equipmentId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: officeEquipmentKeys.detail(equipmentId),
    queryFn: () => officeEquipmentApi.get(equipmentId),
  });

  if (isLoading) return <Spin size="small" />;
  if (!data?.consumables) return null;

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 8 }}>
        Чем заправлять
      </Typography.Title>
      {data.consumables.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          // Не «ничего нет», а «неизвестно чем»: тот же срез собирает окно моделей отбором «без
          // расходника», и по нему номенклатуру дозаполняют.
          description="К модели этого аппарата не привязан ни один картридж или тонер"
        />
      ) : (
        <Space orientation="vertical" size={6} style={{ width: '100%' }}>
          {data.consumables.map((item) => (
            <SupplyRow key={item.id} item={item} />
          ))}
        </Space>
      )}
    </>
  );
}

function SupplyRow({ item }: { item: OfficeEquipmentConsumableRefDto }) {
  return (
    <Space size={8} wrap>
      {/* Код первым: по нему заказывают, и он же связывает строку со счётом поставщика. */}
      <Typography.Text type="secondary">{item.code}</Typography.Text>
      <Typography.Text>{item.name}</Typography.Text>
      {/* Цвет — не украшение: у цветной серии позиций несколько, и различает их только он (Р5). */}
      {item.color && <Typography.Text type="secondary">{item.color}</Typography.Text>}
      {/* Ноль читается с одного взгляда: «есть на складе» и «надо заказывать» — разные действия. */}
      {item.quantity === 0 ? (
        <Typography.Text type="danger" strong>
          нет в наличии
        </Typography.Text>
      ) : (
        <Typography.Text strong>в наличии {item.quantity}</Typography.Text>
      )}
    </Space>
  );
}
