import { Alert, Button, Skeleton, Space, Tag, Typography } from 'antd';
import type { AssignmentChangeDto, RequestAssignmentHistoryDto } from '@technic/contracts';
import {
  assignmentHistoryNote,
  assignmentOriginLabels,
  assignmentSegments,
  driverStateLabel,
  tailVehicleMismatch,
  unknownDriverSegments,
  type AssignmentSegment,
  type AssignmentTerm,
} from './assignmentTimeline';
import { formatDateOnly } from './shared';

/**
 * «Состав по датам» — история заявки, прочитанная человеком (этап 6 плана
 * `docs/assignment-periods-plan.md`, §9).
 *
 * ЗАЧЕМ. До разреза у заявки было одно назначение на весь срок, и вопрос «кто работал в марте»
 * решался по бумаге. Теперь у неё отрезки — с какого числа какая машина и какой машинист, — и
 * блок отвечает ровно на этот вопрос. Он же объясняет отказ: пока за какие-то дни человек
 * неизвестен, портал не выпишет за них лист ЭСМ-2, и «заявка не готова» перестаёт быть загадкой.
 *
 * ЧТО ЗДЕСЬ ПОКАЗАНО ЧЕСТНО, А НЕ ПУСТОЙ СТРОКОЙ. Состояний машиниста три (Р19), и третье —
 * `unknown` — не «забыли заполнить»: история восстановлена по бланкам, человек в них напечатан, а
 * кто это был, из бумаги не следует. Пустая строка на этом месте читалась бы как «машиниста не
 * было», то есть как ошибка в выданном документе.
 *
 * ЧТО ЗДЕСЬ НЕ ПРЯЧЕТСЯ. Решение, заведённое за концом срока, дремлет и ждёт продления (Р24). Ему
 * своя строка «Ожидает продления срока» с датой и кнопкой отмены: спрятанное решение через неделю
 * заводят второй раз, а потом оба оживают вместе с продлением.
 */
interface Props {
  history: RequestAssignmentHistoryDto | undefined;
  loading: boolean;
  term: AssignmentTerm;
  /** Машина назначения — правая половина сравнения «хвост истории против назначения» (Р31). */
  assignment: { vehicleId: string; name: string } | null;
  /** Имя машиниста по идентификатору: строка истории носит состояние, а не человека. */
  driverName: (personId: string) => string | undefined;
  /** «Сегодня»; им отбираются решения, которые ещё не наступили, — их и предлагают отменить. */
  today: string;
  /**
   * Отменить решение группой (В2). Не передана — отменять нечем: у роли нет права вести состояние
   * заявки, и предлагать действие, которым ручка ответит 403, значит обещать то, чего не будет.
   */
  onCancelGroup?: (group: { changeGroupId: string; segment: AssignmentSegment }) => void;
}

export function AssignmentHistoryPanel({
  history,
  loading,
  term,
  assignment,
  driverName,
  today,
  onCancelGroup,
}: Props) {
  if (loading) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (!history) return null;

  const segments = assignmentSegments(history.changes, term);
  const note = assignmentHistoryNote(history);
  const unknown = unknownDriverSegments(segments);
  const tail = tailVehicleMismatch(segments, term, assignment);

  return (
    <Space direction="vertical" size={12} style={{ display: 'flex' }}>
      <Typography.Text strong>Состав по датам</Typography.Text>

      {/* Расхождение хвоста (Р31) — первым: оно про то, чем заявка закрыта **после** конца срока,
        и узнать о нём человек обязан до продления, а не из выписанных не на ту машину листов. */}
      {tail && <TailMismatchAlert tail={tail} />}

      {segments.length === 0 ? (
        <Typography.Text type="secondary">
          Отрезков пока нет: история заявки не заведена.
        </Typography.Text>
      ) : (
        <Space direction="vertical" size={8} style={{ display: 'flex' }}>
          {segments.map((segment) => (
            <SegmentRow
              key={segment.from}
              segment={segment}
              driverName={driverName}
              today={today}
              onCancelGroup={onCancelGroup}
            />
          ))}
        </Space>
      )}

      {/* Почему заявка «не готова» — словами и с днями. Общая фраза без дат заставляла бы искать
        пробелы глазами по всему сроку. */}
      {(note || unknown.length > 0) && (
        <Alert
          type="warning"
          showIcon
          message="История заявки неполна"
          description={
            <>
              {note && <div>{note}</div>}
              {unknown.length > 0 && (
                <>
                  <div style={{ marginTop: note ? 8 : 0 }}>
                    Машинист неизвестен на этих днях — назовите его, и заявка станет готова:
                  </div>
                  <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                    {unknown.map((s) => (
                      <li key={s.from}>{segmentDates(s)}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          }
        />
      )}
    </Space>
  );
}

/**
 * Расхождение хвоста поимённо: чем заявка закрыта после конца срока — машиной истории или машиной
 * назначения (Р31).
 *
 * Отдельным компонентом, потому что тот же отказ приходит и предпросмотром
 * (`requiredVehicleResolution`): у пяти дверей модуля ответ общий, и два разных текста об одном и
 * том же положении дел означали бы, что человек читает про разное.
 */
export function TailMismatchAlert({
  tail,
}: {
  tail: { tailVehicleName: string; assignmentVehicleName: string; since: string };
}) {
  return (
    <Alert
      type="warning"
      showIcon
      message="Не решено, чем заявка закрыта после конца срока"
      description={
        <>
          <div>
            История ведёт заявку на «{tail.tailVehicleName}», а назначена на ней «
            {tail.assignmentVehicleName}». Пока это расхождение не разрешено, срок продлить нельзя:
            листы с {formatDateOnly(tail.since)} выписались бы на машину истории, хотя работа и
            ставки относятся к машине назначения.
          </div>
          <div style={{ marginTop: 8 }}>
            Решают его ремонтом истории — там говорят, какая из двух машин работает дальше. Смене
            машиниста расхождение не мешает: она новых дней не открывает.
          </div>
        </>
      }
    />
  );
}

/** Один отрезок строкой: даты, машина, машинист и то, чем решение заведено. */
function SegmentRow({
  segment,
  driverName,
  today,
  onCancelGroup,
}: {
  segment: AssignmentSegment;
  driverName: (personId: string) => string | undefined;
  today: string;
  onCancelGroup?: (group: { changeGroupId: string; segment: AssignmentSegment }) => void;
}) {
  const cancellable = onCancelGroup ? cancellableGroupId(segment, today) : null;
  return (
    <div style={{ lineHeight: 1.5 }}>
      <Space size={8} wrap>
        <Typography.Text strong>{segmentDates(segment)}</Typography.Text>
        {segment.dormant && <Tag color="gold">Ожидает продления срока</Tag>}
        {/* Восстановленное по бумаге отличается от заведённого людьми: за первым нет ни автора,
          ни причины — есть только бланк, из которого его вывели. */}
        {segment.starts.some((row) => row.origin === 'backfill') && <Tag>По бланкам</Tag>}
        {cancellable && (
          <Button
            size="small"
            onClick={() => onCancelGroup!({ changeGroupId: cancellable, segment })}
          >
            Отменить решение
          </Button>
        )}
      </Space>
      <div>
        <Typography.Text>{segment.vehicle?.name ?? 'техника не задана'}</Typography.Text>
        {' · машинист: '}
        <Typography.Text>{driverStateLabel(segment.driver, driverName)}</Typography.Text>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {segment.starts.map(changeLine).join(' · ')}
      </Typography.Text>
    </div>
  );
}

/** Границы отрезка: у дремлющего правой нет — её задаст продление, и обещать её сейчас нечем. */
function segmentDates(segment: AssignmentSegment): string {
  return segment.to
    ? `${formatDateOnly(segment.from)} — ${formatDateOnly(segment.to)}`
    : `с ${formatDateOnly(segment.from)}`;
}

/** Чем решение заведено и кем: журнал читают, чтобы понять, что правили, а не только чем кончилось. */
function changeLine(row: AssignmentChangeDto): string {
  const who = row.createdByName ? `, ${row.createdByName}` : '';
  return `${assignmentOriginLabels[row.origin]}${who}`;
}

/**
 * Группа, которую **эта** дверь согласится отменить, — теми же правилами, какими отвечает сервер
 * (`assertCancellable`, Р13, Р31). Кнопка не должна вести человека в отказ.
 *
 * Отменяются два рода решений:
 *
 * - **будущее решение о машинисте** — оно ещё не наступило, работы за ним нет, и снять его дешевле,
 *   чем переигрывать назначением другого человека;
 * - **дремлющая граница хвоста** (`tail_resolution`) — ровно пока она дремлет: продлили срок, и
 *   она стала обычным решением о технике, вместе с которым уедут ставки и занятость.
 *
 * Всё остальное здесь не отменяется, и это не осторожность портала: начальное назначение задаёт
 * перевод заявки в работу, решение о технике снимается вместе с машиной другой дверью, а
 * заполнение неизвестного прошлого снимает та же дверь, которая его сделала (Ю2).
 */
function cancellableGroupId(segment: AssignmentSegment, today: string): string | null {
  const rows = segment.starts;
  if (rows.length === 0) return null;
  const groupId = rows[0]!.changeGroupId;
  if (rows.some((row) => row.changeGroupId !== groupId)) return null;
  if (rows.every((row) => row.origin === 'tail_resolution')) {
    return segment.dormant ? groupId : null;
  }
  if (rows.some((row) => row.dimension === 'vehicle')) return null;
  const forbidden = ['assignment', 'known_fill', 'unknown_remainder'];
  if (rows.some((row) => forbidden.includes(row.origin))) return null;
  // Прошедшие дни отменой не правятся — на них назначают другого человека, чтобы у правки остались
  // причина и автор. Дремлющее решение отменяется в любую дату: работы за ним ещё нет.
  return segment.dormant || segment.from > today ? groupId : null;
}
