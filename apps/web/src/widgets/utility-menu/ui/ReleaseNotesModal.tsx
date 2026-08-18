import { Button, Collapse, Empty, Skeleton, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  releaseAdrCountLabel,
  releaseItemKindColors,
  releaseItemKindLabels,
  releaseVersionLabel,
  type ReleaseDto,
  type ReleaseItemDto,
} from '@technic/contracts';
import { useReleases } from '@entities/release';
import { ViewModal } from '@shared/ui';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Дата выпуска словами — «6 августа 2026». В таблицах портал печатает `DD.MM.YYYY`, но здесь дата
 * не колонка, по которой сверяют строки, а отметка на шкале: выравнивать её не с чем, а месяц
 * словом читается без разбора цифр.
 *
 * Без перевода в московский пояс: `releasedOn` — календарный день без времени, и `tz` из браузера
 * восточнее Москвы сдвинул бы выпуск на день назад (тем же рассуждением живёт `formatDateOnly`).
 */
const formatReleasedOn = (releasedOn: string): string => dayjs(releasedOn).format('D MMMM YYYY');

/**
 * Шапка выпуска — то, по чему его узнают в свёрнутом списке: номер версии, когда доехало и о чём
 * был блок. Версия крупнее остального намеренно: её называют вслух («а это уже с новыми
 * бланками?»), и хвост номера отвечает на вопрос быстрее, чем список пунктов (ADR 0077).
 *
 * Тег «новое» — про непрочитанное, а не про вид изменения: одноимённый зелёный «Новое» стоит
 * внутри выпуска у пунктов, и различает их место — в шапке или в строке.
 */
function ReleaseHeader({ release, isNew }: { release: ReleaseDto; isNew: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <Typography.Text strong style={{ fontSize: 15 }}>
        {releaseVersionLabel(release.version)}
      </Typography.Text>
      {isNew && <Tag color="red">новое</Tag>}
      <Typography.Text type="secondary">
        {formatReleasedOn(release.releasedOn)} · {release.title}
      </Typography.Text>
    </div>
  );
}

/**
 * Пункты выпуска. Тег слева от строки, а не над ней: он подсказывает, чего ждать от строки, и
 * читаться должен по дороге к тексту, а не вместо него.
 *
 * Пустой список законен — бывает выпуск из одних изменений схемы, — и говорит об этом словами:
 * пустая раскрытая панель выглядит недогрузившейся.
 */
function ReleaseItems({ items }: { items: ReleaseItemDto[] }) {
  if (items.length === 0) {
    return <Typography.Text type="secondary">Снаружи изменений не видно</Typography.Text>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item, index) => (
        // Ключом индекс: своего идентификатора у пункта нет — он живёт строкой в `items` выпуска,
        // и порядок этих строк меняется только вместе со всем выпуском.
        <div key={index} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <Tag
            color={releaseItemKindColors[item.kind]}
            style={{ marginInlineEnd: 0, flex: '0 0 auto' }}
          >
            {releaseItemKindLabels[item.kind]}
          </Tag>
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Список выпусков. Раскрыт только новейший: за ним и приходят, а остальные шесть раскрытыми
 * превратили бы окно в ленту, по которой надо ещё доскроллить до вчерашнего.
 */
function ReleaseList({ releases, unseenSince }: { releases: ReleaseDto[]; unseenSince: number }) {
  const newest = releases[0];
  if (!newest) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Пока пусто" />;

  return (
    <Collapse
      defaultActiveKey={[String(newest.seq)]}
      items={releases.map((release) => ({
        // Ключ — `seq`, а не строка версии: он и так сквозной, а версия сменит второе число на
        // следующем этапе портала, и одинаковые ключи встретились бы в одном списке.
        key: String(release.seq),
        label: <ReleaseHeader release={release} isNew={release.seq > unseenSince} />,
        // Вес выпуска — справа от шапки: он отвечает «большой блок или мелочь» ещё до раскрытия.
        extra: (
          <Typography.Text type="secondary" style={{ whiteSpace: 'nowrap' }}>
            {releaseAdrCountLabel(release.adrCount)}
          </Typography.Text>
        ),
        children: <ReleaseItems items={release.items} />,
      }))}
    />
  );
}

/**
 * Что нового в портале (ADR 0077). Портал разворачивается непрерывно, и до этого окна пользователь
 * узнавал об изменениях двумя способами: замечал сам либо спрашивал в поддержке. Соседний
 * `AppUpdateBanner` отвечает на другой вопрос — «страница устарела»; общего кода у них нет.
 *
 * Содержимое пересобирается при каждом открытии (`destroyOnHidden`): за время сессии успевает
 * доехать новый выпуск, и раскрытым должен быть он, а не тот, что был новейшим при первом
 * открытии.
 *
 * Ошибку и ожидание окно проговаривает тихо и конечно: журнал — не работа, ради которой сюда
 * пришли, и вечный спиннер вместо списка новостей раздражал бы сильнее, чем отсутствие самих
 * новостей.
 */
export function ReleaseNotesModal({ open, onClose }: Props) {
  const { releases, isLoading, isError, unseenSince } = useReleases();

  return (
    <ViewModal
      title="Что нового"
      open={open}
      onClose={onClose}
      width={640}
      destroyOnHidden
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      {isLoading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : isError ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Журнал сейчас недоступен" />
      ) : (
        <ReleaseList releases={releases} unseenSince={unseenSince} />
      )}
    </ViewModal>
  );
}
