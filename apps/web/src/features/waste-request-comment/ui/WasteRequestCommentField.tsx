import { useEffect, useState } from 'react';
import { Button, Input, Typography } from 'antd';
import { wasteRequestCommentLines, type WasteRequestDto } from '@technic/contracts';

interface Props {
  onSave?: (request: WasteRequestDto, text: string) => void;
  request: WasteRequestDto;
  saving?: boolean;
}

/**
 * Request comment as two signed lines (ADR 0053), with the executor line editable when allowed.
 * An empty field means "nothing said", which is how the executor note is removed.
 */
export function WasteRequestCommentField({ onSave, request, saving }: Props) {
  const [draft, setDraft] = useState(request.operatorComment);
  // The card is reopened on a neighbouring request and the list refreshes after saving: the draft
  // follows the request itself, otherwise it would keep the previous request's text.
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
          {/* On its own row rather than beside the button: the text is multi-line, and a button in
              the same group would stretch to the full field height. */}
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
              // Unchanged text has nothing to save: a needless version bump would break open cards
              // of other users with a version conflict.
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
