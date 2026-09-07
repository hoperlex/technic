/**
 * Состояние разбора: ход распознавания файла и полоса сверок заявки. Вынесено из `TicketCard`
 * тем же бюджетом качества, но граница не только в строках — здесь ни одного поля с бумаги.
 *
 * Карточка показывает ПРОЧИТАННОЕ и молчит о том, откуда оно взялось; эти два компонента —
 * наоборот: что стало с файлом (страницы, попытки, отказ) и что показала сверка с заявкой.
 * Читатель у них тоже свой — не тот, кто вычитывает номер талона, а тот, кто ждёт, когда разбор
 * вообще закончится.
 */
import { Alert, Button, Space, Typography } from 'antd';
import type { WasteTicketCheckDto, WasteTicketDto, WasteTicketFileDto } from '@technic/contracts';
import { ticketDate } from './ticketDate';

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
export function FileState({ file }: { file: WasteTicketFileDto }) {
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
      <Space orientation="vertical" size={0}>
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
      <Space orientation="vertical" size={0}>
        <Typography.Text>Файл разобран</Typography.Text>
        {pagesLine}
      </Space>
    );
  }
  if (file.status === 'pending') {
    return (
      <Space orientation="vertical" size={0}>
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
    <Space orientation="vertical" size={0}>
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
 * Замечание, у которого есть проверяемая замена года, и талон, к которому оно относится
 * (ADR 0166, п. 5 и п. 6).
 *
 * Условия показа кнопки собраны здесь, а не разбросаны по разметке, потому что каждое из них —
 * отдельное решение, а не оформление:
 *
 * - **подсказки нет** — сервер не нашёл замены года, приводящей дату в окно якоря; предлагать
 *   правку «на глазок» кнопка не имеет права, значение строит сервер;
 * - **замечание принято** — человек уже решил, что расхождение законное (вывоз был позже
 *   плановой даты), и кнопка звала бы исправлять верную дату;
 * - **талон отклонён** — он не участвует ни в сверке, ни в подсчётах, и править в нём нечего;
 * - **дата спорна** — проходы прочитали разное, значения у талона нет вовсе, и менять «только
 *   год» не в чем: спор разбирают вручную кнопкой «Разобрать» (Р9).
 *
 * Талон ищется по `check.subjectKey` — у построчных проверок это его идентификатор. Не нашёлся
 * (полоса и список разъехались между перерисовками) — кнопки нет: проверить условия нечем.
 *
 * Права здесь не проверяются намеренно и это не упущение: вся панель разбора монтируется только
 * с `wasteRequests.ticketReview` (`WasteRequestViewModal`, ADR 0114, Р25), и «Подтвердить»,
 * «Исправить», «Не талон» рядом живут по тому же признаку. Своя проверка означала бы второе
 * правило доступа, которое однажды разойдётся с первым.
 */
function yearFixTarget(
  check: WasteTicketCheckDto,
  tickets: readonly WasteTicketDto[],
): { ticket: WasteTicketDto; issuedOn: string } | null {
  const issuedOn = check.suggestedIssuedOn;
  if (!issuedOn || check.resolution) return null;
  const ticket = tickets.find((row) => row.id === check.subjectKey);
  if (!ticket || ticket.status === 'dismissed') return null;
  if (ticket.needsReviewFields.includes('issuedOn')) return null;
  return { ticket, issuedOn };
}

/**
 * Полоса замечаний. Красным — то, что мешает деньгам, жёлтым — то, что мешает порядку. Снятое
 * замечание не исчезает, а становится серым: человек должен видеть, что расхождение было и кто его
 * принял, иначе следующий разбирающий начнёт с нуля.
 *
 * У расхождения даты рядом с текстом стоит действие «Исправить год на 2026» — там, где сервер
 * построил проверяемую замену (ADR 0166, п. 6). Кнопка здесь, а не в карточке талона, потому что
 * исправляет она именно это замечание: подсказка живёт в нём, гаснет вместе с ним, и человек
 * читает повод и правку одной строкой.
 */
export function ChecksStrip({
  checks,
  preliminary,
  hasTickets,
  tickets,
  busyTicketId,
  onFixYear,
}: {
  checks: WasteTicketCheckDto[];
  preliminary: boolean;
  /** Есть ли хоть один неотклонённый талон: без них сверять нечего, и зелёное было бы враньём. */
  hasTickets: boolean;
  /**
   * Талоны заявки. Замечание несёт только `subjectKey`, а условия показа кнопки года — свойства
   * самого талона (отклонён ли он, спорна ли у него дата), и взять их больше неоткуда.
   */
  tickets: readonly WasteTicketDto[];
  /** Талон, по которому панель ведёт запрос: тот же признак занятости (`busyId`), что у карточек. */
  busyTicketId: string | null;
  /** Правка года по подсказке. Своей мутации у полосы нет — запросы ведёт панель, как и все прочие. */
  onFixYear: (ticketId: string, issuedOn: string) => void;
}) {
  // «Расхождений нет» и «сверять нечего» — разные ответы, и путать их дороже всего именно здесь:
  // заявка с приложенной, но не прочитанной бумагой выглядела бы проверенной (Р29).
  if (!hasTickets) {
    return (
      <Alert
        type="warning"
        showIcon
        title="Талоны не разобраны — сверять нечего"
        description="Ни одного талона по этой заявке не заведено: ни машиной, ни человеком. Объём, дата и номер не проверены."
      />
    );
  }
  if (checks.length === 0) {
    return (
      <Alert
        type="success"
        showIcon
        title={preliminary ? 'Расхождений нет (предварительно)' : 'Расхождений нет'}
      />
    );
  }
  return (
    <Space orientation="vertical" size={6} style={{ width: '100%' }}>
      {checks.map((check) => {
        const fix = yearFixTarget(check, tickets);
        // Занятость берётся по талону, а не по замечанию: панель ведёт один запрос на строку
        // (`busyId`), и правка года — такое же действие над талоном, как подтверждение.
        const busy = fix !== null && busyTicketId === fix.ticket.id;
        return (
          <Alert
            key={`${check.code}:${check.subjectKey}`}
            // Снятое замечание становится серым, а не исчезает: следующий разбирающий должен видеть,
            // что расхождение было и кто его принял, иначе он начнёт разбираться с нуля.
            type={check.resolution ? 'info' : check.severity === 'error' ? 'error' : 'warning'}
            showIcon
            title={check.message}
            description={
              check.resolution
                ? `Принято: ${check.resolution.acceptedByName} · ${check.resolution.comment}`
                : check.preliminary
                  ? 'Предварительно: не все талоны подтверждены'
                  : undefined
            }
            action={
              fix ? (
                <Button
                  size="small"
                  // Второго запроса быть не должно: сервер строит подсказку заново под замком
                  // заявки, и повторный клик по уже исправленной дате получил бы конфликт —
                  // отказ там, где всё сделано, человек прочитает как поломку.
                  loading={busy}
                  disabled={busy}
                  // Полная дата — в подсказке: в подписи стоит год, потому что меняется только он,
                  // но увидеть результат человек должен целиком и по-русски, как на бланке.
                  title={`Дата талона станет ${ticketDate(fix.issuedOn)}; меняется только год`}
                  onClick={() => onFixYear(fix.ticket.id, fix.issuedOn)}
                >
                  {`Исправить год на ${fix.issuedOn.slice(0, 4)}`}
                </Button>
              ) : undefined
            }
          />
        );
      })}
    </Space>
  );
}
