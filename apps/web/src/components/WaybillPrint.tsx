import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Alert, App, Badge, Button, Spin, Tooltip } from 'antd';
import { DownloadOutlined, PrinterOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  canPrintWaybill,
  WAYBILL_CANCELLED_PRINT_MESSAGE,
  type WaybillStatus,
} from '@technic/contracts';
import { waybillsApi } from '../api/resources';
import { useIsMobile } from '@shared/lib';
import { errorMessage } from '../utils/format';
import { ViewModal } from '@shared/ui';

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
 * Пачка листов печатается тем же окном и тем же диалогом: сервер отдаёт один документ, в котором
 * бланки идут подряд, — иначе десять листов означали бы десять окон и десять подтверждений
 * печати.
 *
 * Выгрузка xlsx рядом остаётся: бланк иногда правят руками — вписывают то, чего портал не ведёт
 * (показания одометра, движение горючего), — и делают это в редакторе таблиц.
 */

/** Что печатаем: один лист или пачку. `title` — заголовок окна и подпись документа. */
export interface PrintTarget {
  ids: string[];
  title: string;
}

interface Props {
  /** null — окно закрыто. */
  target: PrintTarget | null;
  onClose: () => void;
}

export function WaybillPrintModal({ target, onClose }: Props) {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ключ запроса — сами листы: окно переоткрывают на соседнем листе и на другой пачке.
  const key = target?.ids.join(',') ?? '';

  useEffect(() => {
    if (!key) return;
    const ids = key.split(',');
    let revoked: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(null);

    const load = ids.length === 1 ? waybillsApi.printPdf(ids[0]!) : waybillsApi.printBatch(ids);
    void load
      .then((blob) => {
        if (cancelled) return;
        revoked = URL.createObjectURL(blob);
        setUrl(revoked);
        // Отметка «печатали» считается по факту запроса бланка (ADR 0037): журнал показывает её
        // точкой на кнопке, и без обновления она появилась бы только при следующем заходе.
        void qc.invalidateQueries({ queryKey: ['waybills'] });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });

    return () => {
      cancelled = true;
      // Копия живёт ровно пока открыто окно: закрыли — вкладка её отпускает.
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [key, qc]);

  /**
   * Печать — диалогом самого браузера: он знает про принтеры, поля и двустороннюю печать, и
   * подменять его нечем. Бланк уже подогнан под A4 сервером, менять масштаб в диалоге не нужно.
   */
  const print = () => {
    frame.current?.contentWindow?.focus();
    frame.current?.contentWindow?.print();
  };

  const single = target?.ids.length === 1 ? target.ids[0]! : null;

  return (
    <ViewModal
      title={target?.title ?? 'Путевой лист'}
      open={!!target}
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
        // Выгрузка — только у одиночного листа: xlsx правят по одному, и «скачать пачку» одним
        // файлом было бы неправдой (бланк в книге один).
        ...(single
          ? [
              <ExportWaybillButton
                key="export"
                waybillId={single}
                number={target!.title}
                size="middle"
              >
                Скачать xlsx
              </ExportWaybillButton>,
            ]
          : []),
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
          title={target?.title ?? 'Путевой лист'}
          style={{ width: '100%', height: '100%', border: 0 }}
        />
      )}
    </ViewModal>
  );
}

/**
 * Точка в правом нижнем углу кнопки: этот лист уже печатали или уже выгружали — кто угодно и
 * когда угодно, в том числе пачкой.
 *
 * Отметка отвечает на вопрос «бумага уже уехала?»: второй экземпляр того же номера на руках у
 * двух людей хуже лишнего похода в журнал. Она не запрещает повторить — печать испорченного при
 * подаче бланка обычное дело, — а только не даёт сделать это не глядя.
 */
function MarkDot({
  marked,
  at,
  size,
  children,
}: {
  marked: boolean;
  /** Когда это было — подсказкой: «уже печатали» без даты вызывает тот же вопрос, что и молчание. */
  at?: string | null;
  size: 'small' | 'middle';
  children: ReactNode;
}) {
  if (!marked) return <>{children}</>;
  return (
    <Badge
      dot
      color="blue"
      // Точка уезжает из угла кнопки вниз: сверху её перекрывает подсказка, а справа — соседняя
      // кнопка ряда действий.
      offset={size === 'small' ? [-3, 18] : [-4, 26]}
      title={at ? `Уже уходило: ${new Date(at).toLocaleString('ru-RU')}` : 'Уже уходило'}
    >
      {children}
    </Badge>
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
  status = 'issued',
  exportedAt,
  children,
}: {
  /** null — лист ещё не выбран (окно закрыто). */
  waybillId: string | null;
  number: string;
  size?: 'small' | 'middle';
  /** Состояние листа: аннулированный не выгружают — бланк списан (`canPrintWaybill`). */
  status?: WaybillStatus;
  /** Когда лист выгружали в последний раз; пусто — ни разу. */
  exportedAt?: string | null;
  children?: ReactNode;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const allowed = canPrintWaybill(status);

  const save = async () => {
    if (!waybillId) return;
    setSaving(true);
    try {
      await waybillsApi.exportFile(waybillId, number);
      void qc.invalidateQueries({ queryKey: ['waybills'] });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Tooltip title={allowed ? 'Скачать бланк (xlsx)' : WAYBILL_CANCELLED_PRINT_MESSAGE}>
      {/* Обёртка нужна выключенной кнопке: antd гасит на ней события указателя, и подсказка,
        объясняющая запрет, не открылась бы вовсе. */}
      <span>
        <MarkDot marked={!!exportedAt && allowed} at={exportedAt} size={size}>
          <Button
            size={size}
            icon={<DownloadOutlined />}
            loading={saving}
            disabled={!waybillId || !allowed}
            aria-label="Скачать бланк"
            onClick={() => void save()}
          >
            {children}
          </Button>
        </MarkDot>
      </span>
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
  status = 'issued',
  printedAt,
  children,
}: {
  waybillId: string;
  number: string;
  size?: 'small' | 'middle';
  /** Аннулированный лист не печатают ни одной ролью (`canPrintWaybill`). */
  status?: WaybillStatus;
  /** Когда лист печатали в последний раз; пусто — ни разу. */
  printedAt?: string | null;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const allowed = canPrintWaybill(status);

  return (
    <>
      <Tooltip title={allowed ? 'Печать бланка' : WAYBILL_CANCELLED_PRINT_MESSAGE}>
        <span>
          <MarkDot marked={!!printedAt && allowed} at={printedAt} size={size}>
            <Button
              size={size}
              icon={<PrinterOutlined />}
              disabled={!allowed}
              aria-label="Печать бланка"
              onClick={() => setOpen(true)}
            >
              {children}
            </Button>
          </MarkDot>
        </span>
      </Tooltip>
      <WaybillPrintModal
        target={open ? { ids: [waybillId], title: `Путевой лист ${number}` } : null}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
