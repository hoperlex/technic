import { Space, Typography } from 'antd';
import {
  type GarageDriverDto,
  type LicenseDisplayState,
  licenseDefectLabels,
  licenseDisplayState,
} from '@technic/contracts';
import { formatDateOnly } from '../../utils/date';
import { DASH, SUB } from './shared';

/**
 * Удостоверение в строке гаражного дня (гараж → «Водители»): каким документом человеку выпишут лист
 * на выбранный день — и годится ли этот документ вообще.
 *
 * Две строки, номер и срок; категорий в срезе больше нет. Категориями задают другой вопрос — «кто у
 * нас с CE», — и задают его карточке водителя в справочнике, где по ним и решают, кого сажать за
 * машину. В срезе дня они занимали первую строку графы, отвечая не на то, с чем гараж открывают.
 *
 * Годность считается на **день среза**, а не на сегодня: гараж отвечает про выбранный день, и
 * документ, годный сегодня, к пятнице бывает уже негоден. Считает её `licenseDisplayState`, и она же
 * решает, что старше: дефект (`licenseDefect`, приезжает от сервера) старше срока. Считать одну
 * дату было бы мало — отклонённый документ с будущим сроком получил бы подпись «просрочено», то
 * есть неправду о том, почему им нельзя выписывать лист.
 *
 * Просроченный срок в строке — теперь обычное дело, а не сбой: годного документа у человека может не
 * быть вовсе, и сервер показывает запасной того же вида (`displayDocumentOf`), чтобы графа не
 * молчала. Правило выписки при этом не сдвинулось: лист выписывается по годному документу, и пробелы
 * комплекта (`gaps`) считаются по нему же.
 */

/**
 * Слово о негодности для таблицы: дефект — полным именем справочника (`licenseDefectLabels`, теми же
 * словами, что в карточке водителя), истечение — одним словом. Годному документу сказать нечего.
 */
function cellWord(state: LicenseDisplayState): string | null {
  if (state === 'valid' || state === 'none') return null;
  return state === 'expiring' ? 'истекает' : licenseDefectLabels[state];
}

/**
 * Цвет второй строки. Красный — «этим документом лист не выписать», жёлтый — «выписать можно, но
 * скоро нельзя будет». Бессрочный документ (`none`) остаётся обычным текстом наравне с годным:
 * пустая графа срока и вышедший срок — разные вещи, и подсвечивать первую не за что.
 */
function cellType(state: LicenseDisplayState) {
  if (state === 'expiring') return 'warning' as const;
  return state === 'valid' || state === 'none' ? ('secondary' as const) : ('danger' as const);
}

/**
 * Ячейка «Удостоверение»: номер строкой и срок со словом о негодности — второй.
 *
 * Обе строки с обрезом antd: графа 150 px, и «Документ отклонён при проверке» в ней целиком не
 * помещается — пущенное в перенос, оно растило бы строку таблицы втрое. Подсказка при этом
 * всплывает по факту обреза (тем же приёмом, что у подписи машины в `BusyVehicleCell`), а цвет
 * читается и у обрезанного слова.
 *
 * Прочерк — когда сказать нечего вовсе: документ не заведён, и о нём уже сказано пометкой пробелов
 * в соседней графе «Состояние». Пустая ячейка читалась бы как «не загрузилось».
 */
export function LicenseCell({ row, on }: { row: GarageDriverDto; on: string }) {
  const state = licenseDisplayState(
    { expiresOn: row.licenseExpiresOn, defect: row.licenseDefect },
    on,
  );
  const number = row.licenseNumber || null;
  const sub = [
    row.licenseExpiresOn ? `до ${formatDateOnly(row.licenseExpiresOn)}` : null,
    cellWord(state),
  ]
    .filter(Boolean)
    .join(' · ');
  if (!number && !sub) return DASH;
  return (
    // `display: flex` у обёртки не украшение: `Space` иначе inline-flex, ширина у него по
    // содержимому, и обрезаться строкам было бы не от чего — они вылезли бы в соседнюю графу.
    <Space orientation="vertical" size={0} style={{ display: 'flex' }}>
      <Typography.Text ellipsis={{ tooltip: number ?? '' }}>{number ?? '—'}</Typography.Text>
      {sub && (
        <Typography.Text {...SUB} type={cellType(state)} ellipsis={{ tooltip: sub }}>
          {sub}
        </Typography.Text>
      )}
    </Space>
  );
}

/**
 * Негодность словом — для карточки телефона. Слова короткие и свои, а не подписи справочника: строка
 * карточки идёт сплошным текстом рядом с номером и сроком, и «Документ отклонён при проверке»
 * посреди неё читался бы отдельным предложением.
 */
const CARD_WORDS: Record<LicenseDisplayState, string | null> = {
  revoked: 'аннулировано',
  rejected: 'отклонено',
  expired: 'просрочено',
  expiring: 'истекает',
  valid: null,
  none: null,
};

/**
 * То же удостоверение строкой карточки: «00 00 000100 · до 12.03.2027 · просрочено».
 *
 * Негодность здесь передаётся словом, а не цветом, — и это не упрощение: в шапке карточки цвет уже
 * занят тегом состояния («назначен», «свободен»), и второй цветной знак рядом спорил бы с ним за
 * то же чтение. Слово же читается и на солнце, и в списке из десятка карточек подряд.
 */
export function licenseCardLine(row: GarageDriverDto, on: string): string {
  const state = licenseDisplayState(
    { expiresOn: row.licenseExpiresOn, defect: row.licenseDefect },
    on,
  );
  return (
    [
      row.licenseNumber || null,
      row.licenseExpiresOn ? `до ${formatDateOnly(row.licenseExpiresOn)}` : null,
      CARD_WORDS[state],
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}
