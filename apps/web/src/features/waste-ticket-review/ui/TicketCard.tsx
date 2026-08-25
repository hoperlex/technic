/**
 * Карточка талона и её части — вынесены из `WasteTicketsPanel` (бюджет качества: новый файл не
 * длиннее 400 строк).
 *
 * Граница проходит там, где она и так была: панель ведёт запросы, мутации и окна, здесь лежит
 * показ прочитанного с бумаги, а ход разбора и сверки — в `RecognitionState`. Зависимость
 * односторонняя: панель зовёт отсюда карточку, обратно не ходит ничего, вызовов API нет ни одного.
 */
import type { ReactNode } from 'react';
import { Button, Card, Space, Tag, Tooltip, Typography } from 'antd';
import type {
  WasteTicketCandidateDto,
  WasteTicketDto,
  WasteTicketField,
  WasteTicketPageDto,
} from '@technic/contracts';
import { ticketDate } from './ticketDate';

/**
 * Талон карточкой: четыре поля, ради которых бумагу и собирают, — номер, дата, объём, адрес.
 *
 * Строкой таблицы это читалось хуже: значения тонули среди служебных колонок, а сверять с бумагой
 * приходится поле за полем. Здесь же рядом кнопка «Скан» — открыть тот самый лист, с которого
 * значение прочитано, и номер страницы, если в файле их несколько.
 *
 * Спорное поле остаётся на своём месте в списке: пустое значение с двумя кандидатами — такой же
 * ответ, как прочитанный (Р14), и прятать его в отдельный блок значило бы разлучать вопрос с
 * остальными полями того же талона.
 */
export function TicketCard({
  ticket,
  page,
  busy,
  onOpenScan,
  onConfirm,
  onEdit,
  onDismiss,
  onAcceptProposal,
  onDismissProposal,
}: {
  ticket: WasteTicketDto;
  page: WasteTicketPageDto | null;
  busy: boolean;
  onOpenScan: (fileId: string, filename: string) => void;
  onConfirm: () => void;
  onEdit: () => void;
  onDismiss: () => void;
  onAcceptProposal: () => void;
  onDismissProposal: () => void;
}) {
  const field = (label: string, node: ReactNode) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
      <Typography.Text type="secondary" style={{ minWidth: 92, fontSize: 13 }}>
        {label}
      </Typography.Text>
      <Typography.Text style={{ fontSize: 14 }}>{node}</Typography.Text>
    </div>
  );

  const volume = ticket.needsReviewFields.includes('volumeM3') ? (
    <Disputed field="volumeM3" label="объём" candidates={ticket.candidates} />
  ) : ticket.volumeM3 == null ? (
    ticket.workKind === 'idle' ? (
      <Typography.Text type="secondary">простой — объёма нет</Typography.Text>
    ) : (
      '—'
    )
  ) : (
    `${ticket.volumeM3} м³`
  );

  return (
    <Card size="small" styles={{ body: { padding: 12 } }}>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Space size={8} wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space size={8} wrap>
            <TicketState ticket={ticket} />
            {/* Место талона на кадре: «2 из 2» — это и есть разбивка, когда в одном файле их
                несколько. Без неё две карточки выглядят как две заявки. */}
            {page && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                страница {page.pageNo}
                {page.ticketsFound > 1 ? `, талон ${ticket.seq} из ${page.ticketsFound}` : ''}
              </Typography.Text>
            )}
          </Space>
          {page && (
            <Button size="small" onClick={() => onOpenScan(page.fileId, `страница ${page.pageNo}`)}>
              Скан
            </Button>
          )}
        </Space>

        {field(
          '№ талона',
          ticket.needsReviewFields.includes('number') ? (
            <Disputed field="number" label="номер" candidates={ticket.candidates} />
          ) : (
            ticket.number || '—'
          ),
        )}
        {field(
          'Дата',
          ticket.needsReviewFields.includes('issuedOn') ? (
            <Disputed field="issuedOn" label="дату" candidates={ticket.candidates} />
          ) : (
            // По-русски, как на бланке: 17.08.2026. `YYYY-MM-DD` — это формат хранения и обмена,
            // и человеку, сверяющему с бумагой, он читается как чужая запись.
            ticketDate(ticket.issuedOn)
          ),
        )}
        {field('Объём', volume)}
        {field('Адрес', ticket.addressRaw || '—')}

        {ticket.proposal && (
          <Proposal
            ticket={ticket}
            busy={busy}
            onAccept={onAcceptProposal}
            onDismiss={onDismissProposal}
          />
        )}

        {ticket.status !== 'dismissed' && (
          <Space size={4}>
            {ticket.status === 'confirmed' ? (
              <Button size="small" type="link" onClick={onEdit}>
                Исправить
              </Button>
            ) : (
              <>
                <Button
                  size="small"
                  type="link"
                  loading={busy}
                  disabled={ticket.needsReviewFields.length > 0}
                  title={
                    ticket.needsReviewFields.length > 0
                      ? 'Сначала разберите спорные поля'
                      : undefined
                  }
                  onClick={onConfirm}
                >
                  Подтвердить
                </Button>
                <Button size="small" type="link" onClick={onEdit}>
                  {ticket.needsReviewFields.length > 0 ? 'Разобрать' : 'Исправить'}
                </Button>
                <Button size="small" type="link" danger onClick={onDismiss}>
                  Не талон
                </Button>
              </>
            )}
          </Space>
        )}
      </Space>
    </Card>
  );
}

/**
 * Предложение перераспознавания (Р13): новый проход прочитал иначе строку, которую человек уже
 * трогал. Талон при этом не менялся — подтверждённый занимает номер, ручной написан человеком, — и
 * решение остаётся за ним: принять чтение целиком или отклонить.
 *
 * Показываются только отличия: перечислять поля, совпавшие с талоном, значит прятать в них те два,
 * ради которых предложение и заведено.
 */
function Proposal({
  ticket,
  busy,
  onAccept,
  onDismiss,
}: {
  ticket: WasteTicketDto;
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const p = ticket.proposal!;
  const diffs: string[] = [];
  if (p.number !== ticket.number) diffs.push(`№ ${ticket.number || '—'} → ${p.number || '—'}`);
  if ((p.issuedOn ?? null) !== (ticket.issuedOn ?? null)) {
    diffs.push(`дата ${ticketDate(ticket.issuedOn)} → ${ticketDate(p.issuedOn)}`);
  }
  if ((p.volumeM3 ?? null) !== (ticket.volumeM3 ?? null)) {
    diffs.push(`объём ${ticket.volumeM3 ?? '—'} → ${p.volumeM3 ?? '—'}`);
  }
  if (p.addressRaw !== ticket.addressRaw) diffs.push('адрес');
  return (
    <Space direction="vertical" size={0}>
      <Tooltip title="Новый проход прочитал иначе. Талон не менялся — решать вам">
        <Tag color="purple" style={{ marginInlineEnd: 0 }}>
          новое чтение
        </Tag>
      </Tooltip>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {diffs.join('; ')}
      </Typography.Text>
      <Space size={0}>
        <Button size="small" type="link" loading={busy} onClick={onAccept}>
          Принять
        </Button>
        <Button size="small" type="link" onClick={onDismiss}>
          Отклонить
        </Button>
      </Space>
    </Space>
  );
}

/** Спорное поле: значения нет, потому что модели прочитали разное (Р14). */
function Disputed({
  field,
  label,
  candidates,
}: {
  field: WasteTicketField;
  label: string;
  candidates: readonly WasteTicketCandidateDto[];
}) {
  // Варианты показываются с указанием, какая модель что прочитала: это честнее произвольно
  // выбранного значения старшей модели, которая ошибается реже, но ошибается (Р14). Без вариантов
  // «поле спорное» отправляет человека к скану вслепую.
  const own = candidates.filter((c) => c.field === field);
  return (
    <Tooltip
      title={
        own.length > 0 ? (
          <Space direction="vertical" size={0}>
            <span>Прочитали по-разному:</span>
            {own.map((c, i) => (
              <span key={`${c.model}-${i}`}>
                {c.value || '(пусто)'} — {c.model || 'модель не названа'}
              </span>
            ))}
            <span>Впишите верное кнопкой «Разобрать».</span>
          </Space>
        ) : (
          `Модели прочитали ${label} по-разному — разберите вручную`
        )
      }
    >
      <Space size={4} wrap>
        <Tag color="gold" style={{ marginInlineEnd: 0 }}>
          спорно
        </Tag>
        {own.map((c, i) => (
          <Typography.Text key={`${c.model}-${i}`} type="secondary" style={{ fontSize: 12 }}>
            {c.value || '—'}
            {i < own.length - 1 ? ' /' : ''}
          </Typography.Text>
        ))}
      </Space>
    </Tooltip>
  );
}

function TicketState({ ticket }: { ticket: WasteTicketDto }) {
  if (ticket.status === 'confirmed') {
    return (
      <Space size={4}>
        <Tag color="green">подтверждён</Tag>
        {ticket.origin === 'manual' && <Tag>вручную</Tag>}
        {ticket.duplicateOverride && <Tag color="orange">другая бумага</Tag>}
      </Space>
    );
  }
  if (ticket.status === 'dismissed') return <Tag>снят</Tag>;
  return <Tag color="blue">на проверке</Tag>;
}

/** Состояние файла словами человека, а не кодом (Р29). */
