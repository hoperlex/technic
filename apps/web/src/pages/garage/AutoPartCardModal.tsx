import { useState } from 'react';
import { Button, Space, Spin, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { autoPartApi, autoPartKeys } from '@entities/auto-part';
import { ViewFields, ViewModal } from '@shared/ui';
import { formatDateTime } from '../../utils/format';
import { AutoPartFormModal } from './AutoPartFormModal';
import { AutoPartStockJournal } from './AutoPartStockJournal';
import { AutoPartStockModal } from './AutoPartStockModal';
import type { ApplicabilityOption } from './autoPartApplicability';
import { applicabilityTag } from './autoPartColumns';

/**
 * Карточка автозапчасти окном поверх вкладки (план `docs/auto-parts-plan.md`, Р14, §8; ADR 0120;
 * концепт с. 3): реквизиты, применимость, остаток с кнопкой и лента движения.
 *
 * Окном, а не страницей: смотрят её из списка и возвращаются в список — отдельный адрес отнимал
 * бы отбор и страницу, на которых человек стоял. Названа при этом карточка в адресе (`?part=<id>`)
 * — ссылку присылают соседу, «назад» её закрывает, перезагрузка оставляет открытой.
 *
 * Читают карточку все, кому виден гараж (Р10): ответить «есть ли на складе фильтр» должен всякий.
 * Различаются кнопки — правка позиции под `autoParts.manage`, остаток под `autoParts.stock`, — и
 * без права кнопки нет вовсе, а не «есть, но отказывает».
 *
 * **Оба окна действий живут внутри этого окна, а не рядом с ним.** У antd два независимых окна
 * получают одинаковый `z-index` (`useZIndex`: базовый уровень без родительского контекста), и
 * порядок решает очередь портала в теле документа — то есть окно правки, открытое раньше карточки,
 * оказалось бы ПОД ней. Вложенное окно берёт уровень родителя и всегда выше него.
 */

interface Props {
  /** Позиция из адреса; `null` — карточка закрыта. */
  partId: string | null;
  onClose: () => void;
  /** Ведение справочника (Р10): без него карточка остаётся чтением с журналом. */
  canManage: boolean;
  /** Движение склада (Р10): своё право, и кнопка остатка показана только с ним. */
  canStock: boolean;
  /** Перечень применимости для вложенной формы — тот же, что у отбора вкладки (Р8). */
  options: ApplicabilityOption[];
  optionsLoading?: boolean;
}

export function AutoPartCardModal({
  partId,
  onClose,
  canManage,
  canStock,
  options,
  optionsLoading,
}: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const [stockOpen, setStockOpen] = useState(false);

  /**
   * Карточка грузится по идентификатору, а не берётся строкой списка: ленту журнала приносит
   * только она (`GET /:id`), и второй ручки под журнал не заводили намеренно — вторая дверь к тем
   * же данным это второе место, где решают, что показывать и в каком порядке.
   */
  const { data: part, isFetching } = useQuery({
    queryKey: autoPartKeys.detail(partId ?? ''),
    queryFn: () => autoPartApi.get(partId!),
    enabled: !!partId,
  });

  const title = part ? `${part.name}${part.code ? ` · ${part.code}` : ''}` : 'Автозапчасть';

  return (
    <ViewModal
      title={title}
      open={!!partId}
      onClose={onClose}
      width={860}
      // Содержимое пересобирается при каждом открытии: карточку открывают на соседней строке, а
      // раскрытая лента прошлой позиции к ней отношения не имеет.
      destroyOnHidden
      footer={
        <Space>
          {/* Правка — из карточки, а не из строки списка: правят, глядя на журнал, а журнал
              приходит только сюда (концепт с. 3). */}
          {canManage && part && <Button onClick={() => setEditOpen(true)}>Изменить</Button>}
          <Button type="primary" onClick={onClose}>
            Закрыть
          </Button>
        </Space>
      }
    >
      {!part ? (
        <Spin />
      ) : (
        <>
          <ViewFields
            items={[
              { key: 'name', label: 'Наименование', children: part.name },
              {
                key: 'code',
                label: 'Код',
                // Кода может не быть вовсе (Р12): это законное состояние позиции, и прочерк
                // говорит об этом прямо.
                children: part.code || <Typography.Text type="secondary">—</Typography.Text>,
              },
              { key: 'unit', label: 'Единица', children: part.unit },
              {
                key: 'isActive',
                label: 'Статус',
                children: (
                  <Tag color={part.isActive ? 'green' : 'default'}>
                    {part.isActive ? 'Активна' : 'Погашена'}
                  </Tag>
                ),
              },
            ]}
          />

          {/*
           * Остаток — отдельным блоком, а не строкой реквизитов, и это не оформление: он
           * единственное, что меняется своим действием и своим правом (Р3). Рядом с числом стоит
           * время последней правки: «12» без ответа «когда» читается как «сейчас», а последнее
           * движение могло быть в июле.
           */}
          <div style={{ margin: '12px 0', padding: 12, background: '#f6ffed', borderRadius: 6 }}>
            <Space size={16} wrap align="center">
              <span>
                <Typography.Text type="secondary">Остаток: </Typography.Text>
                <Typography.Text strong style={{ fontSize: 22 }}>
                  {part.quantity}
                </Typography.Text>{' '}
                <Typography.Text>{part.unit}</Typography.Text>
              </span>
              {/* Без права на склад кнопки нет вовсе (Р10): её выдают механику, а менеджер и
                  диспетчер вкладку только читают. */}
              {canStock && <Button onClick={() => setStockOpen(true)}>Изменить остаток</Button>}
              <Typography.Text type="secondary">
                обновлён {formatDateTime(part.updatedAt)}
              </Typography.Text>
            </Space>
          </div>

          <Typography.Title level={5}>Применимость</Typography.Title>
          {part.applicability.length === 0 ? (
            // Пустая разметка законна (Р8), но молчать о её последствиях нельзя: такая деталь не
            // найдётся отбором и не поднимется в подборе формы акта.
            <Typography.Text type="warning">
              Применимость не указана: деталь не найдётся отбором по модели и типу и не поднимется в
              подборе формы акта — её всё равно можно списать, выбрав вручную.
            </Typography.Text>
          ) : (
            <>
              <div>{part.applicability.map(applicabilityTag)}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Подбор в акте сначала покажет эти совпадения, но не запретит выбрать другую позицию.
              </Typography.Text>
            </>
          )}

          {part.comment && (
            <>
              <Typography.Title level={5} style={{ marginTop: 12 }}>
                Комментарий
              </Typography.Title>
              <Typography.Paragraph>{part.comment}</Typography.Paragraph>
            </>
          )}

          <AutoPartStockJournal entries={part.stockEntries} loading={isFetching} />

          {/* Оба окна — внутри карточки: у независимых окон antd одинаковый уровень, и порядок
              решала бы очередь портала (см. шапку файла). */}
          <AutoPartFormModal
            open={editOpen}
            onCancel={() => setEditOpen(false)}
            record={part}
            canStock={canStock}
            options={options}
            optionsLoading={optionsLoading}
          />
          <AutoPartStockModal part={stockOpen ? part : null} onClose={() => setStockOpen(false)} />
        </>
      )}
    </ViewModal>
  );
}
