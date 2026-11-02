import { useState } from 'react';
import { Button } from 'antd';
import { FileExcelOutlined } from '@ant-design/icons';
import { useIsMobile } from '@shared/lib';
import { ViewModal } from '@shared/ui';
import { ReadingsReportForm } from './ReadingsReportForm';

/**
 * The garage header's «Отчёт» (ADR 0241): one book, so the window offers no choice of export —
 * only the explanation and the period.
 *
 * The form is mounted only while the window is open (`destroyOnHidden`): each opening starts from
 * the default period instead of the one picked last time, the way the «Выгрузки» tab starts.
 */
export function ReadingsReportButton() {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  return (
    <>
      <Button
        icon={<FileExcelOutlined />}
        aria-label="Отчёт о работе строительной техники"
        title="Отчёт о работе строительной техники"
        onClick={() => setOpen(true)}
      >
        {isMobile ? null : 'Отчёт'}
      </Button>
      <ViewModal
        title="Отчёт о работе строительной техники"
        open={open}
        onClose={() => setOpen(false)}
        width={640}
        footer={null}
        destroyOnHidden
      >
        <ReadingsReportForm />
      </ViewModal>
    </>
  );
}
