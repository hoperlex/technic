import { Alert, Space, Typography } from 'antd';
import type { EarlyEndApprovalPreviewDto } from '@technic/contracts';
import { formatDateOnly } from './shared';
import { listStyle } from './consequencesList';

/**
 * Цена досрочного завершения, прочитанная **до** нажатия (ADR 0178, Р19, Р26): и тем, кто просит
 * сам за себя, и тем, кто визирует чужой запрос.
 *
 * ПОЧЕМУ ЧИСЛА, А НЕ НОМЕРА. Ответ сервера здесь обезличен намеренно: сокращение визирует
 * руководитель строительства, а прав на журнал путевых листов у этой роли нет вовсе — потребуй
 * дверь такое право, обе применяющие ветви стали бы недоступны тем, ради кого они существуют
 * (решение заказчика по В9). Обезличен он для всех, включая администратора, у которого право есть:
 * две формы ответа на одном маршруте разошлись бы при первой же правке.
 *
 * ЧТО ЗДЕСЬ БЫЛО РАНЬШЕ. Портал считал обещание сам — резал срок по календарным неделям и обещал
 * «аннулируются листы за такие-то недели, выписываются заново». Это перестало быть правдой дважды:
 * у линейного заказа недель не существует вовсе (листы просят по одной), а с ADR 0178 сокращение
 * лист не перевыписывает, а **правит**. Считать это порталу нечем, и теперь он не считает: всё
 * приходит от сервера тем же расчётом, который потом отработает.
 *
 * Полей смен здесь нет, и это не забывчивость: нижняя граница новой даты — сегодня, снимаемый
 * диапазон целиком в будущем, а смену будущим днём не заполняют и не подписывают. Множество пусто
 * по построению (Р19), и рисовать под него блок значило бы обещать разговор, которого не будет.
 */

/** «2 листа», «5 листов» — счётное слово рядом с числом, иначе строка читается как телеграмма. */
function sheets(n: number): string {
  const last = n % 10;
  const tens = n % 100;
  if (tens >= 11 && tens <= 14) return `${n} листов`;
  if (last === 1) return `${n} лист`;
  if (last >= 2 && last <= 4) return `${n} листа`;
  return `${n} листов`;
}

interface Props {
  preview: EarlyEndApprovalPreviewDto;
  /** Почему окно вернулось к последствиям само; `null` — человек пришёл сюда обычным порядком. */
  staleReason?: string | null;
}

export function EarlyEndConsequences({ preview, staleReason }: Props) {
  const { paper, linearDays, cancelGroups } = preview;

  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
      {staleReason && (
        <Alert type="warning" showIcon title="Последствия пересчитаны" description={staleReason} />
      )}

      <div style={{ lineHeight: 1.6 }}>
        <Typography.Text strong>
          Последний день работ — {formatDateOnly(preview.newDateTo)}
        </Typography.Text>
        <div>
          <Typography.Text type="secondary">
            Освободится {preview.daysSaved} дн. из заказанных: техника перестанет числиться занятой
            на них.
          </Typography.Text>
        </div>
      </div>

      <div>
        <Typography.Text strong>Путевые листы ЭСМ-2</Typography.Text>
        {paper.trimmed === 0 && paper.cancelled === 0 ? (
          <div>
            <Typography.Text type="secondary">
              Останутся как есть: сокращать и аннулировать нечего.
            </Typography.Text>
          </div>
        ) : (
          <ul style={listStyle}>
            {paper.trimmed > 0 && (
              <li>
                {sheets(paper.trimmed)} будет сокращено
                {paper.trimmedTo ? ` по ${formatDateOnly(paper.trimmedTo)}` : ''}: номер бланка
                остаётся прежним, заново он не выписывается
              </li>
            )}
            {paper.cancelled > 0 && (
              <li>{sheets(paper.cancelled)} будет аннулировано: работ в эти дни не будет</li>
            )}
          </ul>
        )}
      </div>

      {/* Дни линейного заказа — датами, а не номерами рейсов: номер рейса ведёт к бланку, а бланки
        визирующему не показывают. Замороженные названы отдельно: их рейс не отдаст, потому что по
        ним уже выписан действующий лист, и разобраться с ними придётся отдельно. */}
      {linearDays.detachable.length > 0 && (
        <div>
          <Typography.Text strong>Дни в рейсах</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              Уйдут из рейсов — этих дней у заказа больше не будет:{' '}
              {linearDays.detachable.map(formatDateOnly).join(', ')}
            </Typography.Text>
          </div>
        </div>
      )}
      {linearDays.frozen.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="Эти дни рейс не отдаст"
          description={`По ним уже выписан действующий путевой лист: ${linearDays.frozen
            .map(formatDateOnly)
            .join(', ')}. Пока лист не аннулирован, день остаётся в рейсе.`}
        />
      )}

      {/* Гашение решений истории (Д2 плана периодов): вместе со сроком уходят и записи о том, какая
        техника и какой машинист работают после новой даты. Состав здесь не называется — только дни,
        с которых решения вступали в силу: машины и фамилии это то, ради сокрытия чего ответ и
        обезличен. */}
      {cancelGroups.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="Вместе со сроком погаснут записи о технике"
          description={`За новым концом срока остаются решения о том, какая техника и какой машинист работают по заявке; оставить их нельзя — при следующем продлении они ожили бы сами. Гаснут решения от ${cancelGroups
            .map((group) => formatDateOnly(group.effectiveDate))
            .join(', ')}.`}
        />
      )}

      {/* Причину эта дверь у человека не спрашивает, и `reasonRequired` у неё всегда `false`
        (Р19): причина уже названа самим запросом — «что случилось на объекте», — и второе поле под
        неё означало бы два разных объяснения одного действия. Сказать, что действие попадёт в
        журнал коррекций, всё равно надо: это не рядовая правка. */}
      {preview.operationRequirement && (
        <div>
          <Typography.Text strong>Журнал коррекций</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              Сокращение гасит принятые решения о технике — оно попадёт в журнал вместе с причиной,
              указанной в самом запросе.
            </Typography.Text>
          </div>
        </div>
      )}

      {/* День расчёта входит в отпечаток: предпросмотр, сделанный вчера, не сойдётся с командой
        сегодня, даже если ничего больше не изменилось. */}
      <Typography.Text type="secondary">
        Последствия посчитаны на {formatDateOnly(preview.asOf)}.
      </Typography.Text>
    </Space>
  );
}
