import { useLayoutEffect, useRef } from 'react';
import { Alert, Button, Divider, Skeleton, Space, Tag, Typography } from 'antd';
import {
  serviceChatSideLabels,
  type ServiceChatMessageDto,
  type ServiceRequestDto,
} from '@technic/contracts';
import type { ServiceChatFeedState } from '../model/useServiceChatFeed';
import { formatDateTime } from '../../../utils/format';

/** Ярлыки адресатов реплики: сторонами и людьми — ровно теми списками, какими они и хранятся. */
function AddresseeTags({ addressees }: { addressees: ServiceChatMessageDto['addressees'] }) {
  return (
    <>
      {addressees.sides.map((side) => (
        <Tag key={side} color="blue" style={{ marginInlineEnd: 0 }}>
          {serviceChatSideLabels[side]}
        </Tag>
      ))}
      {addressees.users.map((user) => (
        <Tag key={user.id} color="cyan" style={{ marginInlineEnd: 0 }}>
          {user.fullName}
        </Tag>
      ))}
    </>
  );
}

/**
 * Одна реплика: кто, когда, кому и что сказал.
 *
 * **Два разных признака, и путать их нельзя.** «Откуда текст» — это `origin`, и пометка
 * «перенесено из примечания исполнителя» верна для всего, что пришло из того поля: и для
 * миграционного переноса (§3.9), и для реплики, которую написали через адаптер
 * `PATCH /:id/service-comment` выпуска A (§3.10). «Кто и когда сказал» — это `authorId`, и пусто
 * оно ровно у одного случая: у миграции, где автора не восстановить — «кем изменено» и «когда
 * изменено» общие поля заявки, и через месяц там стоит тот, кто последним двигал статус.
 *
 * У адаптера принципал под рукой, и сервер пишет автора и время явно. Ветвление по `origin`
 * стирало бы известное имя и объявляло точное время приблизительным — а история той же заявки
 * автора при этом показывает, и два экрана портала расходились об одном событии.
 */
function ChatMessage({ message }: { message: ServiceChatMessageDto }) {
  const imported = message.origin === 'import';
  const anonymous = message.authorId === null;
  return (
    <div style={{ lineHeight: 1.4 }}>
      <Space size={8} wrap>
        {!anonymous && <Typography.Text strong>{message.authorName}</Typography.Text>}
        {imported && <Tag color="default">перенесено из примечания исполнителя</Tag>}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatDateTime(message.createdAt)}
          {anonymous && ' · дата приблизительная'}
        </Typography.Text>
        <AddresseeTags addressees={message.addressees} />
      </Space>
      {/* Переносы строк сохраняются: списком «что проверили» реплику пишут не реже, чем фразой. */}
      <div style={{ whiteSpace: 'pre-wrap' }}>{message.body}</div>
    </div>
  );
}

/**
 * Сколько прочитанного оставить над полосой «Новые», ведя к ней ленту: реплика-ответ без
 * предыдущей — половина разговора, и «на что это ответ» пришлось бы искать прокруткой вверх.
 */
const CONTEXT_ABOVE_BOUNDARY = 24;

/**
 * Лента реплик, растущая вниз, с полосой «Новые» на границе прочитанного и подгрузкой вверх.
 *
 * Полоса стоит по границе, снятой при ОТКРЫТИИ окна (`newFromSeq`): курсор сдвигается сразу после
 * показа, и живое значение утащило бы полосу вниз на глазах у читателя — то есть спрятало бы ровно
 * то, ради чего он окно и открыл.
 *
 * **Куда лента встаёт (§3.7).** Растёт она вниз, «Показать более ранние» стоит сверху — значит
 * человек по замыслу стоит внизу, у последнего сказанного, а не у самого старого. Отсюда три
 * правила, и все три — в одном слое-эффекте ниже:
 *
 * 1. **При открытии** — к полосе «Новые», если непрочитанное есть, иначе в самый низ. Ровно один
 *    раз за открытие: проводка на каждый ответ опроса уводила бы ленту из-под рук у того, кто
 *    читает старое.
 * 2. **После своей отправки** — вниз: собственная реплика, уехавшая за нижний край, читается как
 *    «не отправилось».
 * 3. **При подгрузке вверх** — никуда: страница встала НАД тем местом, куда человек пришёл, и
 *    смещение восстанавливается по разнице высот. Иначе прочитанное уезжает вниз на высоту
 *    вставленного, и место теряется ровно в тот момент, когда за ним и полезли.
 *
 * Всё это — `useLayoutEffect`: прокрутка до отрисовки промахнулась бы (высоты ещё нет), а после
 * кадра дала бы видимый прыжок с самого верха.
 */
export function ServiceChatFeed({
  feed,
  request,
}: {
  feed: ServiceChatFeedState;
  request: ServiceRequestDto;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const boundaryRef = useRef<HTMLDivElement | null>(null);
  /** Лента прошлого кадра: по верхнему номеру видно вставку сверху, по высоте — насколько уехало. */
  const shown = useRef<{ topSeq: number | null; scrollHeight: number }>({
    topSeq: null,
    scrollHeight: 0,
  });
  /** Начальная проводка сделана — второй раз лента сама никуда не идёт. */
  const settled = useRef(false);
  /** Сколько своих реплик уже увели ленту вниз. */
  const sentSeen = useRef(feed.sentCount);

  useLayoutEffect(() => {
    const box = boxRef.current;
    // Скелет, ошибка и пустая лента: прокручивать нечего, и «начальная проводка» не считается
    // сделанной — она случится, когда реплики покажутся.
    if (!box) return;

    const topSeq = feed.items[0]?.seq ?? null;
    const before = shown.current;
    shown.current = { topSeq, scrollHeight: box.scrollHeight };

    // 1. Сверху встала страница более ранних — держим то же место, а не тот же `scrollTop`.
    if (before.topSeq !== null && topSeq !== null && topSeq < before.topSeq) {
      box.scrollTop += box.scrollHeight - before.scrollHeight;
      return;
    }

    // 2. Своя отправленная реплика — она внизу, и её показывают, а не прячут.
    if (sentSeen.current !== feed.sentCount) {
      sentSeen.current = feed.sentCount;
      box.scrollTop = box.scrollHeight;
      return;
    }

    // 3. Открытие: к полосе «Новые», а без непрочитанного — к последней реплике.
    if (settled.current) return;
    settled.current = true;
    const boundary = boundaryRef.current;
    /*
     * `offsetTop`, а не `getBoundingClientRect`: окно открывается зумом (`scale` от 0.2), и
     * замеренное во время этой анимации расстояние вышло бы во столько же раз меньше — лента
     * вставала на пятую часть пути и полоса оказывалась у нижнего края. `offsetTop` живёт в
     * раскладке, и преобразования предков его не трогают; система координат для него — сама
     * лента, отсюда `position: relative` на контейнере.
     */
    box.scrollTop = boundary
      ? Math.max(0, boundary.offsetTop - CONTEXT_ABOVE_BOUNDARY)
      : box.scrollHeight;
  }, [feed.items, feed.sentCount]);

  if (feed.isPending) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (feed.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="Обсуждение не загрузилось"
        // Курсор прочтения при этом НЕ двигается (§3.4): непрочитанное остаётся непрочитанным,
        // и метка в списке продолжает звать сюда. Об этом и говорится словами — иначе человек
        // решит, что подсветка врёт.
        description="Реплики остались непрочитанными: подсветка не гаснет, пока лента не показана. Откройте окно ещё раз."
      />
    );
  }
  if (feed.items.length === 0) {
    return (
      <Typography.Text type="secondary">
        По заявке {request.displayNumber} пока ничего не написано.
      </Typography.Text>
    );
  }

  return (
    <div
      ref={boxRef}
      className="service-chat-feed"
      // Прокручивается сама лента, а не окно: поле ввода и выбор адресата обязаны остаться на
      // виду — иначе длинная переписка уводит их за нижний край, и «ответить» становится квестом.
      // `position: relative` — не оформление: по нему `offsetTop` полосы «Новые» считается от
      // самой ленты, и проводка к ней не зависит от того, что творится с предками (см. эффект).
      style={{ maxHeight: '46vh', overflowY: 'auto', paddingInlineEnd: 4, position: 'relative' }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {feed.hasMore && (
          <Button size="small" onClick={feed.loadOlder} loading={feed.loadingOlder} block>
            Показать более ранние
          </Button>
        )}
        {feed.items.map((message, index) => {
          const previous = feed.items[index - 1];
          const boundary =
            message.seq > feed.newFromSeq && (!previous || previous.seq <= feed.newFromSeq);
          return (
            // Ref — на обёртку первой непрочитанной: к ней, а не к самому верху, ведётся лента
            // при открытии.
            <div key={message.id} ref={boundary ? boundaryRef : undefined}>
              {boundary && (
                <Divider plain style={{ margin: '0 0 12px' }}>
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    Новые
                  </Typography.Text>
                </Divider>
              )}
              <ChatMessage message={message} />
            </div>
          );
        })}
      </Space>
    </div>
  );
}
