import { useState, type ReactNode } from 'react';
import { Alert, App, Button, Card, Collapse, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WasteTicketCandidateDto,
  WasteTicketFileDto,
  WasteTicketCheckDto,
  WasteTicketDto,
  WasteTicketField,
  WasteTicketPageDto,
} from '@technic/contracts';
import { wasteTicketKeys, wasteTicketsApi, wasteTicketsQuery } from '@entities/waste-ticket';
import { FilePreviewModal } from '../../../components/FileLinks';
import { errorMessage } from '../../../utils/format';
import { ticketDate } from './ticketDate';
import { BlindCheckPanel } from './BlindCheckPanel';
import { TicketFormModal } from './TicketFormModal';

/**
 * Разбор талонов в карточке заявки (ADR 0114, план §9.2).
 *
 * Панель показывается только тому, у кого есть право разбора: распознанные значения — такой же
 * результат сверки, как и замечания, и отдавать их проверяемому нельзя. Без права карточка
 * остаётся прежней — список файлов и просмотр, как было до распознавания.
 *
 * Главное правило экрана: **портал не решает за человека**. Спорное поле (модели прочитали
 * по-разному) остаётся пустым, показывает обоих кандидатов, а подтверждение блокируется — потому
 * что подтвердить значение, которого нет, значит согласиться с пустотой.
 */
export function WasteTicketsPanel({ requestId }: { requestId: string }) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(wasteTicketsQuery(requestId, true));
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Окно талона: `null` — закрыто, `{ticket: null}` — заведение руками, иначе правка. */
  const [form, setForm] = useState<{ ticket: WasteTicketDto | null } | null>(null);
  /** Скан, открытый рядом с полями: сверять цифру с бумагой удобнее не уходя из карточки. */
  const [scan, setScan] = useState<{ fileId: string; filename: string } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: wasteTicketKeys.list(requestId) });

  const confirm = useMutation({
    mutationFn: (vars: { ticketId: string; reason?: string }) =>
      wasteTicketsApi.confirm(requestId, vars.ticketId, {
        duplicateOverrideReason: vars.reason,
      }),
    onSuccess: async (res) => {
      await invalidate();
      message.success(
        res.duplicateOverrideApplied
          ? 'Талон подтверждён, номер отмечен как другая бумага'
          : 'Талон подтверждён',
      );
    },
    onError: (e) => message.error(errorMessage(e)),
    onSettled: () => setBusyId(null),
  });

  const dismiss = useMutation({
    mutationFn: (ticketId: string) => wasteTicketsApi.dismiss(requestId, ticketId, {}),
    onSuccess: async () => {
      await invalidate();
      message.success('Талон снят');
    },
    onError: (e) => message.error(errorMessage(e)),
    onSettled: () => setBusyId(null),
  });

  const acceptProposal = useMutation({
    mutationFn: (vars: { ticketId: string; reason?: string }) =>
      wasteTicketsApi.acceptProposal(requestId, vars.ticketId, {
        duplicateOverrideReason: vars.reason,
      }),
    onSuccess: async () => {
      await invalidate();
      message.success('Новое чтение принято');
    },
    onError: (e) => message.error(errorMessage(e)),
    onSettled: () => setBusyId(null),
  });

  const dismissProposal = useMutation({
    mutationFn: (ticketId: string) => wasteTicketsApi.dismissProposal(requestId, ticketId),
    onSuccess: async () => {
      await invalidate();
      message.success('Предложение отклонено');
    },
    onError: (e) => message.error(errorMessage(e)),
    onSettled: () => setBusyId(null),
  });

  const recognize = useMutation({
    mutationFn: (fileId: string) => wasteTicketsApi.recognize(requestId, fileId),
    onSuccess: async () => {
      await invalidate();
      message.success('Файл отправлен на повторное распознавание');
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  if (isLoading) return <Typography.Text type="secondary">Загружаем талоны…</Typography.Text>;
  if (!data) return null;

  /**
   * Конфликт номера приходит ответом 409 и требует причины. Спрашиваем её тем же действием, а не
   * отдельной кнопкой: клапан ставится **только на конфликтующую строку**, и отдельная ручка «снять
   * ограничение» позволила бы снять его со старшей бумаги, открыв её номер всем следующим дублям.
   */
  const askOverride = (ticket: WasteTicketDto, reason: string) => {
    let text = '';
    modal.confirm({
      title: 'Это разные бумаги?',
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>{reason}</Typography.Text>
          <Typography.Text type="secondary">
            Если номера совпали случайно (разные книжки перевозчика), опишите это — причина уйдёт в
            историю заявки.
          </Typography.Text>
          <textarea
            style={{ width: '100%', minHeight: 72 }}
            onChange={(e) => {
              text = e.target.value;
            }}
          />
        </Space>
      ),
      okText: 'Подтвердить с причиной',
      cancelText: 'Отмена',
      onOk: () => {
        if (text.trim().length < 3) {
          message.error('Опишите, почему бумаги разные');
          return Promise.reject(new Error('reason required'));
        }
        setBusyId(ticket.id);
        return confirm.mutateAsync({ ticketId: ticket.id, reason: text.trim() });
      },
    });
  };

  const onConfirm = (ticket: WasteTicketDto) => {
    setBusyId(ticket.id);
    confirm.mutate(
      { ticketId: ticket.id },
      {
        onError: (e) => {
          const text = errorMessage(e);
          // 409 про номер — не отказ, а вопрос: та же бумага или другая с тем же номером.
          if (text.includes('уже предъявлен')) askOverride(ticket, text);
          else message.error(text);
          setBusyId(null);
        },
      },
    );
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <ChecksStrip
        checks={data.checks}
        preliminary={data.preliminary}
        hasTickets={data.tickets.some((t) => t.status !== 'dismissed')}
      />

      {/* Ручной ввод — равноправный путь, а не запасной: машина читает не всё, а два талона на
          кадре видит как один (Р15). Кнопка на виду всегда, в том числе когда талонов нет вовсе. */}
      <Space size={8}>
        <Button size="small" onClick={() => setForm({ ticket: null })}>
          Добавить талон вручную
        </Button>
      </Space>

      {data.tickets.length === 0 ? (
        <Empty description="Талоны ещё не распознаны" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        // Карточкой на талон, а не строкой таблицы: человек сверяет с бумагой поле за полем, и
        // читать четыре значения по вертикали быстрее, чем выцеплять их из строки среди служебных
        // колонок. Один кадр с двумя талонами даёт две карточки — разбивка видна сразу.
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {data.tickets.map((row) => (
            <TicketCard
              key={row.id}
              ticket={row}
              page={data.pages.find((pg) => pg.id === row.pageId) ?? null}
              busy={busyId === row.id}
              onOpenScan={(fileId, filename) => setScan({ fileId, filename })}
              onConfirm={() => onConfirm(row)}
              onEdit={() => setForm({ ticket: row })}
              onDismiss={() => {
                setBusyId(row.id);
                dismiss.mutate(row.id);
              }}
              onAcceptProposal={() => {
                setBusyId(row.id);
                acceptProposal.mutate({ ticketId: row.id });
              }}
              onDismissProposal={() => {
                setBusyId(row.id);
                dismissProposal.mutate(row.id);
              }}
            />
          ))}
        </Space>
      )}

      {/* «На кадре два талона — проверьте, что распознаны оба» (Р10). Строка появляется только
          когда машина насчитала больше одного: у обычной страницы сообщать нечего. */}
      {data.pages.some((page) => page.ticketsFound > 1) && (
        <Alert
          type="info"
          showIcon
          message="На некоторых кадрах больше одного талона"
          description={data.pages
            .filter((page) => page.ticketsFound > 1)
            .map((page) => `страница ${page.pageNo}: ${page.ticketsFound}`)
            .join('; ')}
        />
      )}

      {data.files.length > 0 && (
        <Collapse
          size="small"
          ghost
          // Развёрнут сразу, если есть что показать по существу: свёрнутый блок с ответом на
          // вопрос «почему талонов нет» ничем не лучше отсутствующего.
          defaultActiveKey={
            data.files.some((f) => f.status !== 'done') ? ['files'] : undefined
          }
          items={[
            {
              key: 'files',
              label: 'Файлы и попытки распознавания',
              children: (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {data.files.map((file) => (
                    <Space key={file.fileId} size={8} wrap>
                      <FileState file={file} />
                      <Button
                        size="small"
                        type="link"
                        onClick={() => recognize.mutate(file.fileId)}
                      >
                        Перераспознать
                      </Button>
                    </Space>
                  ))}
                  {/* Идентификатор запроса в прокси — то, что называют оператору при разборе. */}
                  {data.attempts.map((a) => (
                    <Typography.Text key={a.id} type="secondary" style={{ fontSize: 12 }}>
                      {new Date(a.createdAt).toLocaleString('ru-RU')} · {a.model}
                      {a.modelReported && a.modelReported !== a.model
                        ? ` (отработала ${a.modelReported})`
                        : ''}{' '}
                      · {a.status === 'done' ? 'успех' : `отказ ${a.errorCode}`}
                      {a.status !== 'done' && a.errorClass
                        ? ` (${a.errorClass === 'transient' ? 'повторится' : 'терминальный'}${
                            a.errorScope === 'subsystem' ? ', сбой сервиса' : ''
                          })`
                        : ''}
                      {a.error ? ` — ${a.error}` : ''}
                      {/* Идентификатор запроса в прокси называют оператору при разборе. */}
                      {a.proxyRequestId ? ` · ${a.proxyRequestId}` : ''}
                    </Typography.Text>
                  ))}
                </Space>
              ),
            },
          ]}
        />
      )}

      {/* Перепроверка живёт рядом с талонами, а не отдельным экраном: разбирает её тот же
          человек и тем же правом, а расхождение двух чтений — такая же работа, как замечание. */}
      <BlindCheckPanel requestId={requestId} checks={data.blindChecks} />

      {scan && (
        <FilePreviewModal
          file={{ id: scan.fileId, filename: scan.filename, contentType: 'image/jpeg' }}
          open
          onClose={() => setScan(null)}
        />
      )}

      <TicketFormModal
        requestId={requestId}
        ticket={form?.ticket ?? null}
        open={!!form}
        onClose={() => setForm(null)}
      />
    </Space>
  );
}

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
function TicketCard({
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
/**
 * Состояние файла — главный ответ на вопрос, которого у самих талонов нет: почему их нет вовсе
 * (Р29).
 *
 * Показывается ровно то, что меняет действие человека:
 *
 * - **сколько ещё будет попыток и когда следующая** — иначе «распознаётся…» неотличимо от
 *   «висит навсегда», и человек либо ждёт зря, либо зря зовёт администратора;
 * - **класс сбоя**: временный разберётся сам, терминальный не разберётся никогда — обещать
 *   автоматическое восстановление там значит врать;
 * - **сколько страниц отброшено лимитом** — то, что сверх него, помечается, а не теряется молча.
 */
function FileState({ file }: { file: WasteTicketFileDto }) {
  const skipped = file.totalPages - file.processedPages;
  const pagesLine =
    file.totalPages > 0 ? (
      <Typography.Text type={skipped > 0 ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
        {file.filename ? `${file.filename}: ` : ''}
        страниц {file.totalPages}, разобрано {file.processedPages}
        {skipped > 0 ? ` — ${skipped} сверх лимита, заведите талоны вручную` : ''}
      </Typography.Text>
    ) : null;

  const attempt = file.activeJob ? (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      попытка {file.activeJob.attempt + 1} из {file.activeJob.maxAttempts}
      {file.activeJob.nextRunAt
        ? `, следующая в ${new Date(file.activeJob.nextRunAt).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          })}`
        : ' — выполняется сейчас'}
    </Typography.Text>
  ) : null;

  // Талон приложен, а строки распознавания у него нет: модуль был выключен, когда заявку
  // закрывали. Это не сбой и не ожидание — это работа, которая ждёт человека.
  if (file.status === 'not_queued') {
    return (
      <Space direction="vertical" size={0}>
        <Typography.Text type="warning">
          {file.filename || 'Талон'}: в разбор не поступал
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {file.reason}
        </Typography.Text>
      </Space>
    );
  }
  if (file.status === 'done') {
    return (
      <Space direction="vertical" size={0}>
        <Typography.Text>Файл разобран</Typography.Text>
        {pagesLine}
      </Space>
    );
  }
  if (file.status === 'pending') {
    return (
      <Space direction="vertical" size={0}>
        <Typography.Text>
          Распознаётся…
          {!file.activeJob && (
            <Typography.Text type="danger">
              {' '}
              задача не найдена — повторов не будет, нужен администратор
            </Typography.Text>
          )}
        </Typography.Text>
        {attempt}
        {pagesLine}
      </Space>
    );
  }
  return (
    <Space direction="vertical" size={0}>
      <Typography.Text type="danger">{file.reason || 'Файл не распознан'}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {file.errorClass === 'transient'
          ? 'Сбой временный: портал повторит сам'
          : file.errorScope === 'subsystem'
            ? 'Сбой сервиса: автоматического восстановления не будет, нужен администратор'
            : 'Этот файл прочитать не удалось: перезалейте скан или заведите талон вручную'}
      </Typography.Text>
      {attempt}
      {pagesLine}
    </Space>
  );
}

/**
 * Полоса замечаний. Красным — то, что мешает деньгам, жёлтым — то, что мешает порядку. Снятое
 * замечание не исчезает, а становится серым: человек должен видеть, что расхождение было и кто его
 * принял, иначе следующий разбирающий начнёт с нуля.
 */
function ChecksStrip({
  checks,
  preliminary,
  hasTickets,
}: {
  checks: WasteTicketCheckDto[];
  preliminary: boolean;
  /** Есть ли хоть один неотклонённый талон: без них сверять нечего, и зелёное было бы враньём. */
  hasTickets: boolean;
}) {
  // «Расхождений нет» и «сверять нечего» — разные ответы, и путать их дороже всего именно здесь:
  // заявка с приложенной, но не прочитанной бумагой выглядела бы проверенной (Р29).
  if (!hasTickets) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Талоны не разобраны — сверять нечего"
        description="Ни одного талона по этой заявке не заведено: ни машиной, ни человеком. Объём, дата и номер не проверены."
      />
    );
  }
  if (checks.length === 0) {
    return (
      <Alert
        type="success"
        showIcon
        message={preliminary ? 'Расхождений нет (предварительно)' : 'Расхождений нет'}
      />
    );
  }
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {checks.map((check) => (
        <Alert
          key={`${check.code}:${check.subjectKey}`}
          // Снятое замечание становится серым, а не исчезает: следующий разбирающий должен видеть,
          // что расхождение было и кто его принял, иначе он начнёт разбираться с нуля.
          type={check.resolution ? 'info' : check.severity === 'error' ? 'error' : 'warning'}
          showIcon
          message={check.message}
          description={
            check.resolution
              ? `Принято: ${check.resolution.acceptedByName} · ${check.resolution.comment}`
              : check.preliminary
                ? 'Предварительно: не все талоны подтверждены'
                : undefined
          }
        />
      ))}
    </Space>
  );
}
