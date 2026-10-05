import { Empty, Skeleton, Typography } from 'antd';
import { FileTextOutlined } from '@ant-design/icons';
import type { ManualDto } from '@technic/contracts';

/**
 * Whole-row links mirror support contacts: both lists answer "where can I get help", so another
 * visual language in the same menu corner would read as another portal.
 *
 * Documents live outside the portal. A new tab preserves the form being filled with the manual's
 * help; noreferrer/noopener prevents that external tab from navigating the original via opener.
 */
function ManualLink({ manual }: { manual: ManualDto }) {
  return (
    <a className="support-contact" href={manual.url} target="_blank" rel="noreferrer noopener">
      <FileTextOutlined className="support-contact__icon" />
      <span className="support-contact__body">
        <span className="support-contact__title">{manual.title}</span>
        {/* An empty second line would look truncated rather than intentionally absent. */}
        {manual.description && <span className="support-contact__hint">{manual.description}</span>}
      </span>
    </a>
  );
}

/** The item is always visible, so an empty list needs words rather than an apparently broken window. */
export function ManualsBody({
  manuals,
  isLoading,
  isError,
}: {
  manuals: ManualDto[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <>
      <Typography.Paragraph type="secondary">
        Документы открываются в новой вкладке — портал их не хранит, а только знает, где они лежат.
      </Typography.Paragraph>
      {isLoading ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : isError && manuals.length === 0 ? (
        /* A failed refresh keeps the previous data in react-query. Replacing usable links with
           an error would claim the list is unavailable when only its refresh failed. */
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Список сейчас недоступен" />
      ) : manuals.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Руководств пока нет" />
      ) : (
        manuals.map((manual) => <ManualLink key={manual.id} manual={manual} />)
      )}
    </>
  );
}
