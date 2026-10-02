import { useEffect, useState } from 'react';
import { Button, Input, Typography } from 'antd';
import { wasteRequestCommentLines, type WasteRequestDto } from '@technic/contracts';

interface Props {
  onSave?: (request: WasteRequestDto, text: string) => void;
  request: WasteRequestDto;
  saving?: boolean;
}

/** Show both comment sides while allowing only the executor-owned line to change. */
export function WasteRequestCommentField({ onSave, request, saving }: Props) {
  const [draft, setDraft] = useState(request.operatorComment);
  useEffect(() => setDraft(request.operatorComment), [request.id, request.operatorComment]);
  const lines = wasteRequestCommentLines(request);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {lines.length > 0
        ? lines.map((line) => (
            <div key={line.key}>
              <Typography.Text type="secondary">{line.label}: </Typography.Text>
              {line.text}
            </div>
          ))
        : '—'}
      {onSave && (
        <>
          <Input.TextArea
            rows={2}
            maxLength={2000}
            showCount
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Комментарий исполнителя"
          />
          <div style={{ textAlign: 'right' }}>
            <Button
              type="primary"
              loading={saving}
              disabled={draft.trim() === request.operatorComment}
              onClick={() => onSave(request, draft.trim())}
            >
              Сохранить
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
