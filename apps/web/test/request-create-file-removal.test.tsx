import type { ReactNode } from 'react';
import { App } from 'antd';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { filesApi } from '@entities/file';
import { useFileEditor } from '../src/widgets/vehicle-request-editor/model/useFileEditor';
import { useMechAttachments } from '../src/pages/mech/MechRequestAttachments';
import { useServiceRequestAttachments } from '../src/pages/service/ServiceRequestAttachments';

const fileId = 'uploaded-before-first-post';
const uploaded = {
  id: fileId,
  filename: 'photo.png',
  contentType: 'image/png',
  size: 3,
  status: 'active' as const,
  createdAt: '2026-10-16T08:00:00.000Z',
};
const attempt = { body: { fileIds: [fileId] } };
const wrapper = ({ children }: { children: ReactNode }) => <App>{children}</App>;

afterEach(() => vi.restoreAllMocks());

describe('files frozen in an uncertain create', () => {
  it.each([
    [
      'vehicle',
      () => {
        const files = useFileEditor(attempt);
        return {
          upload: files.upload,
          remove: () => files.remove(fileId),
          count: files.files.length,
        };
      },
    ],
    [
      'mech',
      () => {
        const files = useMechAttachments(null, true, attempt);
        return {
          upload: files.upload,
          remove: () => files.remove({ id: fileId }),
          count: files.shown.length,
        };
      },
    ],
    [
      'service',
      () => {
        const files = useServiceRequestAttachments(attempt);
        return {
          upload: files.upload,
          remove: () => files.remove(uploaded),
          count: files.files.length,
        };
      },
    ],
  ] as const)(
    '%s keeps the uploaded file available for the original retry',
    async (_kind, useFiles) => {
      const upload = vi.spyOn(filesApi, 'upload').mockResolvedValue(uploaded);
      const deleted = vi.spyOn(filesApi, 'remove').mockResolvedValue({ ok: true });
      const hook = renderHook(useFiles, { wrapper });
      await act(async () => hook.result.current.upload(new File(['abc'], 'photo.png')));
      expect(upload).toHaveBeenCalledOnce();
      expect(hook.result.current.count).toBe(1);
      act(() => hook.result.current.remove());
      expect(deleted).not.toHaveBeenCalled();
      expect(hook.result.current.count).toBe(1);
    },
  );
});
