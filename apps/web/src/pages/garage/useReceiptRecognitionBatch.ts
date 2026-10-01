import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { mergeReceiptDrafts, type ReceiptRecognitionStateDto } from '@technic/contracts';
import { autoPartReceiptApi, autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { errorMessage } from '@shared/lib';

export interface RecognitionScan {
  id: string;
  filename: string;
}

type Launch = { status: 'pending' } | { status: 'failed'; message: string };
const POLL_MS = 2000;

/**
 * OCR jobs and permissions belong to individual files, while the form belongs to one receipt.
 * Keep a query and launch state per file so a late response from another scan cannot replace the
 * visible draft. The view is assembled only from the files still attached to the current form.
 */
export function useReceiptRecognitionBatch(
  files: readonly RecognitionScan[],
  uploadCount: number,
  disabled: boolean,
  appliedFileIds: readonly string[],
) {
  const queryClient = useQueryClient();
  const [launches, setLaunches] = useState<Record<string, Launch>>({});
  const started = useRef(new Set<string>());
  const generations = useRef(new Map<string, number>());
  const queries = useQueries({
    queries: files.map((file) => ({
      queryKey: autoPartReceiptKeys.recognition(file.id),
      queryFn: () => autoPartReceiptApi.recognition(file.id),
      refetchInterval: (query: { state: { data?: unknown } }) =>
        (query.state.data as ReceiptRecognitionStateDto | undefined)?.status === 'pending'
          ? POLL_MS
          : false,
    })),
  });

  const start = useCallback(
    (fileId: string, forced: boolean) => {
      const generation = (generations.current.get(fileId) ?? 0) + 1;
      generations.current.set(fileId, generation);
      setLaunches((previous) => ({ ...previous, [fileId]: { status: 'pending' } }));
      void autoPartReceiptApi.recognize(fileId, forced).then(
        (result) => {
          if (generations.current.get(fileId) !== generation) return;
          queryClient.setQueryData(autoPartReceiptKeys.recognition(fileId), result);
          setLaunches((previous) => {
            const next = { ...previous };
            delete next[fileId];
            return next;
          });
        },
        (error: unknown) => {
          if (generations.current.get(fileId) !== generation) return;
          setLaunches((previous) => ({
            ...previous,
            [fileId]: { status: 'failed', message: errorMessage(error) },
          }));
        },
      );
    },
    [queryClient],
  );

  useEffect(() => {
    if (disabled) return;
    files.forEach((file, index) => {
      if (queries[index]?.data?.status !== 'idle' || started.current.has(file.id)) return;
      started.current.add(file.id);
      start(file.id, false);
    });
  }, [disabled, files, queries, start]);

  const entries = files.map((file, index) => ({
    file,
    query: queries[index]!,
    data: queries[index]?.data,
    launch: launches[file.id],
  }));
  const done = entries.filter(
    ({ query, data, launch }) => !query.isError && data?.status === 'done' && data.draft && !launch,
  );
  const failed = entries.filter(
    ({ query, data, launch }) =>
      query.isError || launch?.status === 'failed' || data?.status === 'failed',
  );
  const unsupported = entries.filter(({ data }) => data?.status === 'unsupported');
  const reading =
    uploadCount > 0 ||
    entries.some(
      ({ query, data, launch }) =>
        query.isPending ||
        launch?.status === 'pending' ||
        data?.status === 'pending' ||
        (data?.status === 'idle' && !disabled && !query.isError && launch?.status !== 'failed'),
    );
  const totalFiles = files.length + uploadCount;
  const unApplied = done.filter(({ file }) => !appliedFileIds.includes(file.id));
  const availableDrafts = unApplied.flatMap(({ data }) => (data?.draft ? [data.draft] : []));
  const allDrafts = done.flatMap(({ data }) => (data?.draft ? [data.draft] : []));
  const applyDraft = availableDrafts.length ? mergeReceiptDrafts(availableDrafts) : null;
  const combinedDraft = allDrafts.length ? mergeReceiptDrafts(allDrafts) : null;
  const groupStatus: ReceiptRecognitionStateDto['status'] = reading
    ? 'pending'
    : combinedDraft
      ? 'done'
      : failed.length > 0
        ? 'failed'
        : unsupported.length > 0
          ? 'unsupported'
          : 'idle';
  const first = entries[0];
  const grouped = totalFiles > 1;
  const data: ReceiptRecognitionStateDto | undefined =
    !grouped && first
      ? first.launch?.status === 'failed' && first.data
        ? { ...first.data, status: 'idle', draft: null }
        : first.query.isError && first.data
          ? { ...first.data, status: 'idle', draft: null }
          : first.data
      : totalFiles > 0
        ? {
            fileId: '',
            status: groupStatus,
            queuedAt: null,
            delayed: entries.some(({ data }) => data?.delayed === true),
            totalPages: totalFiles,
            processedPages: done.length,
            draft: combinedDraft,
            errorClass: null,
            errorScope: null,
            message: failed.length ? 'Один или несколько сканов не удалось распознать.' : '',
            duplicate: null,
          }
        : undefined;
  const requestError =
    !grouped && first
      ? first.query.isError
        ? errorMessage(first.query.error)
        : first.launch?.status === 'failed'
          ? first.launch.message
          : undefined
      : undefined;
  const extraNotices =
    grouped && !reading
      ? entries.flatMap(({ file, data, query, launch }) => {
          if (query.isError) return [`${file.filename}: ${errorMessage(query.error)}`];
          if (launch?.status === 'failed') return [`${file.filename}: ${launch.message}`];
          if (data?.status === 'failed') return [`${file.filename}: ${data.message}`];
          if (data?.status === 'unsupported') return [`${file.filename}: ${data.message}`];
          if (data?.duplicate) {
            return [
              `${file.filename}: этот скан уже подшит к чеку № ${data.duplicate.documentNumber} от ${data.duplicate.purchasedOn}`,
            ];
          }
          return [];
        })
      : [];
  const health = useQuery({
    queryKey: autoPartReceiptKeys.recognitionHealth(),
    queryFn: () => autoPartReceiptApi.recognitionHealth(),
    enabled: entries.some(({ data }) => data?.status === 'failed' || data?.delayed === true),
  });

  const retry = () => {
    if (failed.length) {
      failed.forEach(({ file, query }) => {
        if (query.isError) void query.refetch();
        else start(file.id, true);
      });
      return;
    }
    files
      .filter((file) => !unsupported.some((entry) => entry.file.id === file.id))
      .forEach((file) => start(file.id, true));
  };

  return {
    data,
    reading,
    health: health.data,
    requestError,
    extraNotices,
    grouped,
    applyDraft,
    appliedFileIds: unApplied.map(({ file }) => file.id),
    alreadyApplied: !!combinedDraft && unApplied.length === 0,
    applyMode: (appliedFileIds.length > 0 ? 'append' : 'replace') as 'append' | 'replace',
    retry,
    hasFailed: failed.length > 0,
  };
}
