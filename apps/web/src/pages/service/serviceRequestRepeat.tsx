import { useEffect, useRef, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Button, Space, Tag, Typography } from 'antd';
import { RetweetOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router';
import type { ServiceRequestDto } from '@technic/contracts';
import { serviceRepeatSummary } from '@entities/service-request';
import type { BaseParams } from '@shared/lib';
import { EntityLink, type ViewField } from '@shared/ui';
import { SERVICE_FILTER_FIELDS, type ServiceListFilters } from './serviceRequestFilters';
import { formatDate } from '../../utils/format';

/**
 * Ссылка «предыдущие» и режим списка, в который она ведёт (план
 * `docs/office-equipment-repeat-request-plan.md`, Р10).
 *
 * СВОИМ МОДУЛЕМ, ПОТОМУ ЧТО ЭТО ОДНО РЕШЕНИЕ, РАЗЛОЖЕННОЕ НА ДВА ЭКРАНА: строка карточки обещает
 * «столько-то заявок за столько-то дней», а список обязан показать ровно их. Держись половины
 * порознь — в карточке и во вкладке, — и первое же расхождение («Повтор ×3», а в списке одна
 * строка) читалось бы как враньё портала, хотя виноват был бы оставшийся отбор.
 *
 * РЕЖИМ, А НЕ ОТБОР, И РАЗНИЦА ЗДЕСЬ ГЛАВНАЯ. Сервер принимает `repeatFor` ТОЛЬКО в одиночестве:
 * рядом с любым фильтром он отвечает 422 (`serviceRequestListQuerySchema`). Собрать «похожий»
 * отбор портал не может и не пытается — окно у каждой строки своё, а совпадения считаются в
 * области смотрящего (Р8), и сложенный на клиенте `equipmentId + status` показал бы не то число,
 * которое человек только что видел в теге.
 */

/**
 * Адрес списка «предыдущих» — тех самых заявок, которые посчитал тег.
 *
 * Здесь, а не в `utils/links`: там живут переходы, у которых есть ВТОРАЯ половина — право на цель.
 * У этого её нет вовсе. Признак приходит от сервера уже посчитанным в области самого читателя, и
 * ведёт ссылка в тот же список заявок, из которого на неё и смотрят; невидимую заявку сервер
 * закрывает общим 404, а не портал — молчанием ссылки.
 */
export const serviceRepeatPath = (requestId: string): string =>
  `/office-equipment?tab=requests&repeatFor=${requestId}`;

/**
 * Строка карточки «Повторное обращение» — наблюдение и вход в его проверку (Р10).
 *
 * Строки нет ни при `count: 0`, ни при отсутствующем признаке: в первом случае повторов не нашли,
 * во втором — не считали вовсе (окно выключено, расходники, заявка без аппарата). Показать «0
 * заявок за 30 дней» значило бы поставить в карточку строку, которая есть у каждой второй заявки и
 * ни о чём не говорит.
 *
 * Дата последнего совпадения — рядом, а не вместо числа: «последний раз чинили 12.08.2026»
 * отвечает на первый же вопрос, который задают, увидев метку.
 */
export function serviceRepeatFields(request: ServiceRequestDto): ViewField[] {
  const repeat = request.repeat;
  if (!repeat || repeat.count <= 0) return [];
  return [
    {
      key: 'repeat',
      label: 'Повторное обращение',
      full: true,
      children: (
        <Space size={8} wrap>
          <span>{serviceRepeatSummary(repeat)}</span>
          {repeat.lastAt && (
            <Typography.Text type="secondary">
              последняя — {formatDate(repeat.lastAt)}
            </Typography.Text>
          )}
          {/* Настоящей ссылкой, а не кнопкой: список предыдущих открывают и соседней вкладкой —
              чтобы не терять карточку, из которой пришли. */}
          <EntityLink
            to={serviceRepeatPath(request.id)}
            title="Показать предыдущие заявки по этому аппарату"
          >
            Показать предыдущие
          </EntityLink>
        </Space>
      ),
    },
  ];
}

/**
 * ОТБОР ГАСИТ РЕЖИМ, А НЕ СПОРИТ С НИМ, и решается это в ОДНОМ месте — здесь, на сборке запроса.
 *
 * Дверей к отбору у списка больше, чем панель фильтров: строка поиска на телефоне и лупа столбца
 * «Техника» остаются на месте и в режиме. Проверь портал сочетание где-нибудь ещё — состоянием
 * списка, эффектом, — и между нажатием и починкой умещался бы один рендер, то есть настоящий
 * запрос с отказом сервера (422) на каждую букву в поиске. Здесь же сочетание не доживает до
 * сети: режим уступает отбору молча, а человек получает то, что просил, — найденное.
 */
export function serviceRepeatQuery(
  query: BaseParams & ServiceListFilters,
): BaseParams & ServiceListFilters {
  return query.repeatFor && repeatBusy(query) ? { ...query, repeatFor: undefined } : query;
}

/** Задан ли у списка хоть один отбор — то, с чем режим «предыдущие» не сочетается. */
function repeatBusy(params: BaseParams & ServiceListFilters): boolean {
  return !!params.search || SERVICE_FILTER_FIELDS.some((key) => params[key] !== undefined);
}

export interface ServiceRepeatMode {
  /** Список показывает «предыдущие». Отбора у него в этом состоянии нет вовсе — его запрещает сервер. */
  active: boolean;
  /** Чем список отобран и как из этого выйти. Стоит ВМЕСТО панели отборов и очередей-пресетов. */
  banner: ReactNode;
}

/**
 * Режим «предыдущие» у списка заявок: включается адресом, гасится отбором и кнопкой.
 *
 * ПРЕЖНИЕ ОТБОРЫ СНИМАЮТСЯ ЦЕЛИКОМ, И ЭТО НЕ ВЕЖЛИВОСТЬ. Списки помнят набор между сеансами
 * (ADR 0139): человек, вчера отобравший «свою площадку» и «только срочные», сегодня перешёл бы по
 * ссылке и получил 422 — либо, если бы сервер отбор стерпел, список, не совпадающий с числом в
 * теге. Поэтому вход в режим — единственное обновление параметров, в котором разом снимаются все
 * `SERVICE_FILTER_FIELDS` и строка поиска.
 *
 * ЗАПОМНИТЬСЯ РЕЖИМУ НЕЧЕМ: `repeatFor` живёт в параметрах списка, но в `SERVICE_FILTER_FIELDS`
 * его нет — иначе утром человек открыл бы вкладку в списке вчерашних «предыдущих» и без единого
 * следа, откуда он взялся.
 *
 * ПАРАМЕТР АДРЕСА СНИМАЕТСЯ ПОСЛЕ ПРОЧТЕНИЯ, как соседний `?chat=1`: оставленный, он не дал бы
 * войти в режим по той же ссылке во второй раз — адрес не изменился бы, а значит и повода
 * перечитать его не появилось бы. Вкладку при этом никто не спрашивает: `repeatFor` адресован
 * ровно одному списку, в отличие от `?open=`, за который берутся все вкладки раздела сразу.
 */
export function useServiceRepeatMode({
  params,
  setParams,
  onEnter,
}: {
  params: BaseParams & ServiceListFilters;
  setParams: Dispatch<SetStateAction<BaseParams & ServiceListFilters>>;
  /** Закрыть карточку, из которой пришли: ссылку нажимают внутри неё, а ведёт она в список под ней. */
  onEnter: () => void;
}): ServiceRepeatMode {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('repeatFor');

  // Обработчик приходит новой функцией на каждый рендер страницы; в зависимостях эффекта он
  // означал бы повторный вход в режим на каждую перерисовку списка.
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;

  useEffect(() => {
    if (!requested) return;
    setParams((prev) => {
      const next = { ...prev, page: 1, search: undefined, repeatFor: requested };
      for (const key of SERVICE_FILTER_FIELDS) next[key] = undefined;
      return next;
    });
    onEnterRef.current();
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('repeatFor');
        return next;
      },
      { replace: true },
    );
  }, [requested, setParams, setSearchParams]);

  /*
   * Погасший отбором режим (`serviceRepeatQuery`) убирается и из состояния списка — иначе снятый
   * человеком фильтр воскресил бы его сам собой, а плашка над таблицей всё это время обещала бы
   * «предыдущие», которых в запросе уже нет.
   */
  const busy = repeatBusy(params);
  useEffect(() => {
    if (!params.repeatFor || !busy) return;
    setParams((prev) => ({ ...prev, repeatFor: undefined }));
  }, [params.repeatFor, busy, setParams]);

  // Режим показан ровно тогда, когда он и применён к запросу: плашка над списком, отобранным не
  // им, была бы вторым ответом на тот же вопрос — и тем, который врёт.
  const active = !!params.repeatFor && !busy;
  const banner = active ? (
    <Space wrap>
      <Tag color="orange" icon={<RetweetOutlined />} style={{ marginInlineEnd: 0 }}>
        Предыдущие заявки по аппарату
      </Tag>
      {/* Почему в этом списке нет ни отборов, ни очередей — сказано словами: список, у которого
          пропала половина шапки, иначе читался бы как поломка. */}
      <Typography.Text type="secondary">
        Показаны те же заявки, что посчитал признак повтора: отборы к ним не применяются.
      </Typography.Text>
      <Button size="small" onClick={() => setParams((prev) => ({ ...prev, repeatFor: undefined }))}>
        Показать все заявки
      </Button>
    </Space>
  ) : null;

  return { active, banner };
}
