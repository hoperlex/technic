import { Collapse, Empty, Skeleton, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  releaseAdrCountLabel,
  releaseItemKindColors,
  releaseItemKindLabels,
  releaseVersionLabel,
  type ReleaseDto,
  type ReleaseItemDto,
} from '@technic/contracts';
/**
 * Spell out the release date: unlike a table column it is a timeline label with nothing to align
 * against, and a month name is easier to read than digits.
 *
 * No Moscow-time conversion: releasedOn is a calendar date, not a timestamp. Converting a
 * browser east of Moscow would shift the release to the previous day, as with formatDateOnly.
 */
const formatReleasedOn = (releasedOn: string): string => dayjs(releasedOn).format('D MMMM YYYY');

/**
 * A collapsed release is identified by its version, arrival date and subject. The version is
 * deliberately larger: people name it aloud to ask whether a particular change has arrived, and
 * the number answers faster than reading every item (ADR 0077).
 *
 * The red "new" header tag means unread, not the change kind. The green "New" item tag lives
 * inside the release; their different positions distinguish the two meanings.
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
 * Item-kind tags precede their text rather than sitting above it: they guide reading instead of
 * replacing the content.
 *
 * A release containing only schema changes may have no items. Say so: an empty expanded panel
 * would look as if its contents had failed to load.
 */
function ReleaseItems({ items }: { items: ReleaseItemDto[] }) {
  if (items.length === 0) {
    return <Typography.Text type="secondary">Снаружи изменений не видно</Typography.Text>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item, index) => (
        // Items have no identifiers outside their release; the array order changes only with
        // the release itself, so the index is the stable key for this list.
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
 * Expand only the newest release, which is why the reader came. Expanding the six older ones
 * would turn the window into a feed that must be scrolled just to reach yesterday.
 */
function ReleaseList({ releases, unseenSince }: { releases: ReleaseDto[]; unseenSince: number }) {
  const newest = releases[0];
  if (!newest) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Пока пусто" />;

  return (
    <Collapse
      defaultActiveKey={[String(newest.seq)]}
      items={releases.map((release) => ({
        // seq is globally unique. A version's second number can restart at a new portal stage,
        // so using the displayed version instead could produce duplicate keys.
        key: String(release.seq),
        label: <ReleaseHeader release={release} isNew={release.seq > unseenSince} />,
        // Its size belongs beside the header: "large release or small change" before expanding.
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

/** Failure and waiting stay finite and quiet: release news must not interrupt the actual work. */
export function ReleaseNotesBody({
  releases,
  unseenSince,
  isLoading,
  isError,
}: {
  releases: ReleaseDto[];
  unseenSince: number;
  isLoading: boolean;
  isError: boolean;
}) {
  return isLoading ? (
    <Skeleton active paragraph={{ rows: 4 }} />
  ) : isError ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Журнал сейчас недоступен" />
  ) : (
    <ReleaseList releases={releases} unseenSince={unseenSince} />
  );
}
