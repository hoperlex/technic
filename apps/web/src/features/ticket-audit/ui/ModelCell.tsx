import { Tooltip, Typography } from 'antd';
import {
  ESCALATION_ABSENT_NOTE,
  PRIMARY_MODEL_UNNAMED_NOTE,
  type CohortModelView,
} from '../model/cohorts';

/**
 * Ячейка модели: имя, «модель себя не назвала» или прочерк «эскалации не было».
 *
 * Своим файлом, а не внутри таблицы когорт, с тех пор как модель называют два экрана — когорты и
 * лента (§5.2, §5.3). Копия для второго разошлась бы с первой на первой же правке, и одна и та же
 * пустота читалась бы на двух экранах по-разному.
 *
 * Объяснение висит на самом прочерке, а не в подписи под таблицей: на телефоне подпись уезжает
 * под сгиб, а спрашивают об этом именно глядя в ячейку.
 */
export function ModelCell({ view }: { view: CohortModelView }) {
  if (view.kind === 'named') return <Typography.Text>{view.name}</Typography.Text>;
  if (view.kind === 'absent')
    return (
      <Tooltip title={ESCALATION_ABSENT_NOTE}>
        <Typography.Text type="secondary">—</Typography.Text>
      </Tooltip>
    );
  return (
    <Tooltip title={PRIMARY_MODEL_UNNAMED_NOTE}>
      <Typography.Text type="secondary">модель себя не назвала</Typography.Text>
    </Tooltip>
  );
}
