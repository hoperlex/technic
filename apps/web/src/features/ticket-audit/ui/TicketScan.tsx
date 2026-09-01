import { useEffect, useState } from 'react';
import { Alert, Button, Spin, Tooltip, Typography } from 'antd';
import { FileImageOutlined } from '@ant-design/icons';
import { useIsMobile } from '@shared/lib';
import { ViewModal } from '@shared/ui';
import { filesApi } from '../../../api/resources';
import { errorMessage } from '../../../utils/format';
import { SCAN_GONE_NOTE, scanAriaLabel, scanTitle } from '../model/eventRows';

/**
 * Скан талона из строки ленты (§4.2, §5.3 плана).
 *
 * Кнопка СО СЛОВОМ, а не одна лупа: столбец с иконкой без подписи читается как украшение, а
 * решение «идти ли смотреть бумагу» принимают, глядя на строку. Имя для читающих голосом называет
 * и страницу — на кадре бывает два талона, а в файле десяток страниц.
 *
 * Ссылки на API в разметке нет и быть не может: переход по `href` браузер делает без заголовка
 * `Authorization` (токен живёт в памяти вкладки), и вместо картинки человек получил бы 401 в новой
 * вкладке. Ссылка на объект спрашивается той же ручкой файлов, что и у вложений заявки: она
 * подписана, живёт минуты и авторизует себя сама. Тот же запрос пишет в журнал, кто смотрел чужую
 * площадку, — поэтому он делается при ОТКРЫТИИ окна, а не заранее на всю страницу ленты: иначе
 * журнал наполнялся бы просмотрами, которых не было.
 */
export function TicketScanButton({
  fileId,
  pageNo,
}: {
  /** `null` — файла нет; это состояние строки, а не отказ (см. `SCAN_GONE_NOTE`). */
  fileId: string | null;
  pageNo: number | null;
}) {
  const [open, setOpen] = useState(false);

  /*
   * Файла нет — не отключённая кнопка, а сказанное словами состояние. Отключённая кнопка отвечает
   * «нельзя вам» или «портал сломался», а правда другая: талон и заявку ссылка на скан переживает,
   * и пропасть она может только вместе с самим файлом.
   */
  if (fileId === null)
    return (
      <Tooltip title={SCAN_GONE_NOTE}>
        <Typography.Text type="secondary">скан недоступен</Typography.Text>
      </Tooltip>
    );

  return (
    <>
      <Button
        size="small"
        icon={<FileImageOutlined />}
        aria-label={scanAriaLabel(pageNo)}
        onClick={() => setOpen(true)}
      >
        Скан
      </Button>
      {/* Окно монтируется только открытым: смонтированное заранее спросило бы ссылку на каждый
          скан страницы ленты — полсотни записей в журнале просмотров за одно открытие вкладки. */}
      {open ? (
        <TicketScanModal fileId={fileId} pageNo={pageNo} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/**
 * Номер страницы уходит якорем `#page=N`: так открывают нужный лист многостраничного PDF (§4.2) —
 * первая страница вместо второй означала бы «ищите сами». Якорь браузер на сервер не отправляет,
 * поэтому подпись ссылки он не ломает; у снимка одной картинкой он просто ни на что не влияет.
 */
function scanSrc(url: string, pageNo: number | null): string {
  return pageNo === null || pageNo <= 1 ? url : `${url}#page=${pageNo}`;
}

/**
 * Окно просмотра. Показывает содержимое фреймом: тип файла лента не знает — в событии есть ссылка
 * и страница, но не имя и не тип, — а фрейм одинаково показывает и лист PDF, и фотографию талона.
 *
 * Четыре состояния те же, что у экранов раздела: ждём ссылку, ошибка, картинка. Пустого состояния
 * здесь нет — окно открывается только по живому файлу.
 */
function TicketScanModal({
  fileId,
  pageNo,
  onClose,
}: {
  fileId: string;
  pageNo: number | null;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void filesApi
      .downloadUrl(fileId, 'inline')
      .then((dto) => {
        if (!cancelled) setUrl(dto.url);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    // Ответ уже не нужен, если окно закрыли: подписанная ссылка живёт минуты, и следующий показ
    // всё равно возьмёт свежую.
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const title = scanTitle(pageNo);

  return (
    <ViewModal
      title={title}
      open
      onClose={onClose}
      width="90vw"
      footer={<Button onClick={onClose}>Закрыть</Button>}
      // На телефоне окно и так во весь экран: фиксированная высота тела оставила бы под скан
      // полосу в 80 % высоты окна, а не экрана.
      bodyStyle={{
        ...(isMobile ? { height: '100%', padding: 8 } : { height: '80vh' }),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {error ? (
        <Alert type="error" showIcon title="Скан не открылся" description={error} />
      ) : url === null ? (
        <Spin />
      ) : (
        <iframe
          src={scanSrc(url, pageNo)}
          title={title}
          style={{ width: '100%', height: '100%', border: 0 }}
        />
      )}
    </ViewModal>
  );
}
