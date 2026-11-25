import { Button, Space, Typography } from 'antd';
import type { WasteRequestTicketsDto } from '@technic/contracts';
import { ticketFileOutcome as fileOutcome } from '@entities/waste-ticket';

interface Props {
  data: WasteRequestTicketsDto;
  onOpenScan: (scan: { fileId: string; filename: string; contentType?: string }) => void;
  onRecognize: (fileId: string) => void;
  recognizingFileId?: string;
}

/**
 * Attached scans with what was found in them. A file name alone does not answer "is this paper
 * reviewed?", next to the ticket numbers it does: how many tickets a frame holds, and that a file
 * was never read at all.
 *
 * An unread file carries its own «Перераспознать» here, not only in the folded attempt log: reading
 * it is the way out (snow-removal plan, §3.2), the re-close of a request whose earlier attempt left
 * the file without a result included.
 */
export function ScanList({ data, onOpenScan, onRecognize, recognizingFileId }: Props) {
  if (data.files.length === 0) return null;
  return (
    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
      {data.files.map((file) => {
        const pageIds = data.pages.filter((pg) => pg.fileId === file.fileId).map((pg) => pg.id);
        const found = data.tickets.filter(
          (ticket) => ticket.pageId && pageIds.includes(ticket.pageId),
        );
        const outcome = fileOutcome(file);
        return (
          <Space key={file.fileId} size={8} wrap>
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              onClick={() =>
                onOpenScan({
                  fileId: file.fileId,
                  filename: file.filename,
                  contentType: file.contentType,
                })
              }
            >
              {file.filename || 'скан'}
            </Button>
            {found.length > 0 ? (
              <Typography.Text style={{ fontSize: 13 }}>
                {found.map((ticket) => ticket.number || '№ не прочитан').join(', ')}
              </Typography.Text>
            ) : (
              <Typography.Text
                type={outcome.unread ? 'warning' : 'secondary'}
                style={{ fontSize: 13 }}
              >
                {outcome.text}
              </Typography.Text>
            )}
            {outcome.unread && (
              <Button
                size="small"
                loading={recognizingFileId === file.fileId}
                onClick={() => onRecognize(file.fileId)}
              >
                Перераспознать
              </Button>
            )}
          </Space>
        );
      })}
    </Space>
  );
}
