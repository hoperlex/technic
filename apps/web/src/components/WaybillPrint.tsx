import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Spin, Tooltip } from 'antd';
import { DownloadOutlined, PrinterOutlined } from '@ant-design/icons';
import { waybillsApi } from '../api/resources';
import { useIsMobile } from '../hooks/useIsMobile';
import { errorMessage } from '../utils/format';
import { ViewModal } from './ViewModal';

/**
 * Печать путевого листа (ADR 0041).
 *
 * Лист печатают, а не хранят файлом: бумага уезжает с водителем, а электронный экземпляр живёт в
 * журнале портала. Поэтому здесь не «скачать и открыть в Excel», а сразу бланк на экране и диалог
 * печати браузера — тот же бланк из бухгалтерии, переведённый сервером в PDF.
 *
 * Файл приходит телом ответа и показывается фреймом из памяти вкладки (`blob:`): так печать
 * работает и когда API живёт на другом источнике, и не оставляет следа на диске — фрейм с чужого
 * источника печатать нельзя, а сохранять лист, чтобы напечатать, ровно то, от чего уходили.
 *
 * Выгрузка xlsx рядом остаётся: бланк иногда правят руками — вписывают то, чего портал не ведёт
 * (показания одометра, движение горючего), — и делают это в редакторе таблиц.
 */
interface Props {
  /** null — окно закрыто. */
  waybillId: string | null;
  /** Номер листа в заголовке: по нему его ищут в журнале и на бумаге. */
  number: string;
  onClose: () => void;
}

export function WaybillPrintModal({ waybillId, number, onClose }: Props) {
  const isMobile = useIsMobile();
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!waybillId) return;
    let revoked: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(null);

    void waybillsApi
      .printPdf(waybillId)
      .then((blob) => {
        if (cancelled) return;
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });

    return () => {
      cancelled = true;
      // Копия живёт ровно пока открыто окно: закрыли — вкладка её отпускает.
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [waybillId]);

  /**
   * Печать — диалогом самого браузера: он знает про принтеры, поля и двустороннюю печать, и
   * подменять его нечем. Бланк уже подогнан под A4 сервером, менять масштаб в диалоге не нужно.
   */
  const print = () => {
    frame.current?.contentWindow?.focus();
    frame.current?.contentWindow?.print();
  };

  return (
    <ViewModal
      title={`Путевой лист ${number}`}
      open={!!waybillId}
      onClose={onClose}
      width="90vw"
      // Бланк пересобирается при каждом открытии: окно переоткрывают на соседнем листе.
      destroyOnHidden
      footer={[
        <Button
          key="print"
          type="primary"
          icon={<PrinterOutlined />}
          disabled={!url}
          onClick={print}
        >
          Печать
        </Button>,
        <ExportWaybillButton key="export" waybillId={waybillId} number={number} size="middle">
          Скачать xlsx
        </ExportWaybillButton>,
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
      bodyStyle={{
        ...(isMobile ? { height: '100%', padding: 8 } : { height: '80vh' }),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {error ? (
        <Alert type="error" message="Бланк не подготовился к печати" description={error} showIcon />
      ) : !url ? (
        <Spin tip="Готовим бланк…" />
      ) : (
        <iframe
          ref={frame}
          src={url}
          title={`Путевой лист ${number}`}
          style={{ width: '100%', height: '100%', border: 0 }}
        />
      )}
    </ViewModal>
  );
}

/**
 * Кнопка выгрузки бланка файлом — рядом с печатью и в журнале, и в окне печати.
 *
 * Кнопка, а не ссылка: маршрут закрыт авторизацией, а по `href` браузер идёт без заголовка
 * `Authorization` и получает 401 «Требуется авторизация» в новой вкладке вместо файла. Ссылка
 * здесь стояла с самого начала и не работала ни разу — сохранить бланк было нельзя.
 */
export function ExportWaybillButton({
  waybillId,
  number,
  size = 'small',
  children,
}: {
  /** null — лист ещё не выбран (окно закрыто). */
  waybillId: string | null;
  number: string;
  size?: 'small' | 'middle';
  children?: ReactNode;
}) {
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!waybillId) return;
    setSaving(true);
    try {
      await waybillsApi.exportFile(waybillId, number);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Tooltip title="Скачать бланк (xlsx)">
      <Button
        size={size}
        icon={<DownloadOutlined />}
        loading={saving}
        disabled={!waybillId}
        onClick={() => void save()}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

/**
 * Кнопка печати листа: одна и та же в журнале листов и в карточке заявки — печатают из обоих
 * мест, и вести себя она обязана одинаково.
 */
export function PrintWaybillButton({
  waybillId,
  number,
  size = 'small',
  children,
}: {
  waybillId: string;
  number: string;
  size?: 'small' | 'middle';
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="Печать бланка">
        <Button size={size} icon={<PrinterOutlined />} onClick={() => setOpen(true)}>
          {children}
        </Button>
      </Tooltip>
      <WaybillPrintModal
        waybillId={open ? waybillId : null}
        number={number}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
