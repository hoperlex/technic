import { Tooltip, Typography } from 'antd';
import type { RatioView } from '../model/numbers';
import { CASCADE_FIELDS_NOTE } from '../model/numbers';

/**
 * Ячейка доли сводки.
 *
 * Главное правило экрана нарисовано здесь: **абсолютные числа стоят перед долей** — «9 / 70 13 %»,
 * а не «13 %». При десятках талонов доля скачет на единицы процентов от одного исправления, и
 * читать её надо вместе со знаменателем (§5.1 плана).
 */
export function Ratio({ view }: { view: RatioView }) {
  if (view.kind === 'not-measured') {
    return (
      <Tooltip title={CASCADE_FIELDS_NOTE}>
        {/* Прочерк, а не ноль: ноль означал бы «спора не было», а правда — «спор здесь не
            определён». Пояснение висит на самом прочерке: подпись под таблицей на телефоне
            уезжает под сгиб. */}
        <Typography.Text type="secondary">—</Typography.Text>
      </Tooltip>
    );
  }

  if (view.kind === 'no-data') {
    // Пустая выборка печатается словами, а не нулём: «0 %» читается как «ошибок нет».
    return <Typography.Text type="secondary">нет данных</Typography.Text>;
  }

  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <Typography.Text>
        {view.numerator} / {view.denominator}
      </Typography.Text>
      {view.kind === 'share' ? (
        <Typography.Text strong style={{ marginLeft: 8 }}>
          {view.percent} %
        </Typography.Text>
      ) : null}
      {view.kind === 'small-sample' ? (
        <Tooltip title="Доля считается от тридцати наблюдений и больше: на меньшем числе она скачет на десятки процентов от одного исправления">
          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
            данных недостаточно
          </Typography.Text>
        </Tooltip>
      ) : null}
    </span>
  );
}
