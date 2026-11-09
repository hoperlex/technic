import { useState } from 'react';
import { Typography } from 'antd';
import type { AttachedFileDto } from '@technic/contracts';
import { FilePreviewModal } from '@entities/file';

/**
 * The name of a receipt file as a link to its preview — the block, the version list and the card's
 * history line open a version through this one link, so all three show it the same way: the pages
 * drawn by the portal (P14), «Скачать» in the window.
 *
 * A quarantined file has no name and no link: its content is closed to everyone but the incident
 * review, and the row says so instead of looking like a nameless file.
 *
 * Clicks stop at the wrapper, the preview window's included — React carries an event from a portal
 * up its own tree: on the phone a history event folds on any tap, and neither the link nor «Закрыть»
 * in the preview may fold the line the version was opened from.
 */
export function MechLessorReceiptFileLink({ file }: { file: AttachedFileDto }) {
  const [open, setOpen] = useState(false);
  if (file.quarantined) {
    return <Typography.Text type="secondary">файл скрыт по обращению</Typography.Text>;
  }
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <Typography.Link ellipsis style={{ maxWidth: '100%' }} onClick={() => setOpen(true)}>
        {file.filename}
      </Typography.Link>
      <FilePreviewModal file={file} pdf="pages" open={open} onClose={() => setOpen(false)} />
    </span>
  );
}
