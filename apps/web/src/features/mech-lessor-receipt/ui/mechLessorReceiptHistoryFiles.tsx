import { Space, Typography } from 'antd';
import type { AttachedFileDto, MechRequestDto } from '@technic/contracts';
import type { HistoryFilesRenderer } from '@entities/request-history';
import { MechLessorReceiptFileLink } from './MechLessorReceiptFileLink';

/**
 * The files of the card's history lines (lessor receipt plan, P9, O8): a receipt version opens from
 * the line that attached it, in the same preview as in the block.
 *
 * Only the request's own receipt versions become links — they are what this card may open, the
 * archive included (O17). Every other named file stays its name as text, exactly as before: a
 * requester attachment removed since, or one closed by the archive, would otherwise be a link that
 * ends in a refusal. The history names files; whether a file still opens is the card's knowledge.
 *
 * While only the list row is on screen the retired versions are not loaded yet; their names stay text
 * until the fresh card arrives a moment later.
 */
export function mechLessorReceiptHistoryFiles(request: MechRequestDto): HistoryFilesRenderer {
  const versions = [request.lessorReceipt, ...(request.lessorReceiptRetired ?? [])];
  const receipts = new Map<string, AttachedFileDto>();
  for (const version of versions) if (version?.file) receipts.set(version.file.id, version.file);

  return function renderHistoryFiles(files) {
    return (
      <Space size={[8, 0]} wrap style={{ display: 'inline-flex' }}>
        {files.map((file) => {
          const receipt = receipts.get(file.id);
          if (receipt) return <MechLessorReceiptFileLink key={file.id} file={receipt} />;
          return (
            <Typography.Text key={file.id} type="secondary" style={{ fontSize: 12 }}>
              {file.quarantined ? 'файл скрыт по обращению' : file.filename}
            </Typography.Text>
          );
        })}
      </Space>
    );
  };
}
