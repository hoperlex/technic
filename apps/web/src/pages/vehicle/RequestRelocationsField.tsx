import { useState } from 'react';
import { App, Button, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  routePurposeLabels,
  routePurposeShortLabels,
  type VehicleRequestDto,
  waybillStatusColors,
  waybillStatusLabels,
} from '@technic/contracts';
import { vehicleRequestsApi, vehicleRoutesApi } from '../../api/resources';
import { garageKeys } from '@entities/garage';
import { errorMessage } from '../../utils/format';
import { formatDateOnly } from './shared';
import { VehicleRelocationModal } from './VehicleRelocationModal';

/**
 * Перегоны заявки в её же форме правки: доставка техники на площадку и вывоз с неё (миграция 0082).
 *
 * Раньше их заводили только в двух местах — при переводе в работу (доставку) и из карточки заявки
 * (вывоз), — а убрать ошибочно заведённый было нельзя вовсе: приходилось идти во вкладку маршрутов
 * и удалять рейс оттуда, зная его номер. Между тем правят их как раз тогда, когда открывают саму
 * заявку: технику решили везти тралом, дату сдвинули, вывоз завели не на ту заявку.
 *
 * Их ровно два и по одному на назначение — так держит сервер (`createRelocationRoute`), и здесь
 * предлагается только то, чего ещё нет. Ноль — нормальное состояние: способ доставки портал не
 * ведёт, и техника может приехать тралом, без всякого путевого листа.
 *
 * Действия применяются сразу, а не по «Сохранить»: перегон — это отдельный рейс, а не поле заявки.
 * Форма об этом и говорит: иначе человек ждал бы, что закрытие окна без сохранения его отменит.
 */

const PURPOSES = ['delivery', 'pickup'] as const;

interface Props {
  /** Заявка в работе с назначенной собственной техникой; иначе блок не показывается. */
  request: VehicleRequestDto;
}

export function RequestRelocationsField({ request }: Props) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<(typeof PURPOSES)[number] | null>(null);

  // Ключ тот же, что у карточки заявки: открытая перед этим карточка отдаёт ответ из кэша.
  const { data: relocations, isFetching } = useQuery({
    queryKey: ['vehicle-requests', request.id, 'relocations'],
    queryFn: () => vehicleRequestsApi.relocations(request.id),
  });

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['vehicle-requests', request.id, 'relocations'] }),
      qc.invalidateQueries({ queryKey: ['vehicle-routes'] }),
      qc.invalidateQueries({ queryKey: ['vehicle-requests'] }),
      qc.invalidateQueries({ queryKey: garageKeys.root }),
    ]);
  };

  const remove = useMutation({
    mutationFn: (routeId: string) => vehicleRoutesApi.remove(routeId),
    onSuccess: async () => {
      message.success('Перегон убран');
      await refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const confirmRemove = (routeId: string, displayNumber: string) =>
    modal.confirm({
      title: `Убрать перегон ${displayNumber}?`,
      content: 'Рейс удалится целиком. Завести его заново можно тут же — датой и водителем.',
      okText: 'Убрать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => remove.mutateAsync(routeId),
    });

  const existing = relocations ?? [];
  const missing = PURPOSES.filter((purpose) => !existing.some((r) => r.purpose === purpose));

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        Перегон — отдельный рейс с путевым листом 4-П, и правки здесь применяются сразу, не
        дожидаясь «Сохранить». Технику везут тралом — перегона не заводят вовсе.
      </Typography.Text>

      {existing.length === 0 && !isFetching && (
        <Typography.Text type="secondary">Перегонов нет</Typography.Text>
      )}

      {existing.map((route) => {
        // Лист по рейсу выписывался — рейс остаётся в журнале строгой отчётности навсегда, даже
        // аннулированный (сервер отвечает тем же отказом). Тогда убирать нечего: чинят такое
        // аннулированием листа и правкой самого рейса в карточке маршрута.
        const documented = !!route.waybill;
        return (
          <Space key={route.id} size={8} wrap>
            <Tag color={route.purpose === 'delivery' ? 'blue' : 'gold'}>
              {routePurposeShortLabels[route.purpose]}
            </Tag>
            <span>{route.displayNumber}</span>
            <Typography.Text type="secondary">
              {formatDateOnly(route.routeDate)} · {route.moveFrom} → {route.moveTo}
              {route.driverName ? ` · ${route.driverName}` : ' · водитель не назначен'}
            </Typography.Text>
            {route.waybill && (
              <Tag color={waybillStatusColors[route.waybill.status]}>
                {route.waybill.number} · {waybillStatusLabels[route.waybill.status]}
              </Tag>
            )}
            <span
              title={
                documented
                  ? 'По перегону выписывался путевой лист — рейс остаётся в журнале бланков'
                  : undefined
              }
            >
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={documented || remove.isPending}
                aria-label={`Убрать перегон ${route.displayNumber}`}
                onClick={() => confirmRemove(route.id, route.displayNumber)}
              />
            </span>
          </Space>
        );
      })}

      {missing.length > 0 && (
        <Space size={8} wrap>
          {missing.map((purpose) => (
            <Button
              key={purpose}
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setAdding(purpose)}
            >
              {routePurposeLabels[purpose]}
            </Button>
          ))}
        </Space>
      )}

      <VehicleRelocationModal
        request={adding ? request : null}
        purpose={adding ?? 'delivery'}
        onClose={() => setAdding(null)}
        onDone={() => {
          setAdding(null);
          void refresh();
        }}
      />
    </Space>
  );
}
