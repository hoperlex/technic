/**
 * Состояние разбора: ход распознавания файла и полоса сверок заявки. Вынесено из `TicketCard`
 * тем же бюджетом качества, но граница не только в строках — здесь ни одного поля с бумаги.
 *
 * Карточка показывает ПРОЧИТАННОЕ и молчит о том, откуда оно взялось; эти два компонента —
 * наоборот: что стало с файлом (страницы, попытки, отказ) и что показала сверка с заявкой.
 * Читатель у них тоже свой — не тот, кто вычитывает номер талона, а тот, кто ждёт, когда разбор
 * вообще закончится.
 */
import { Alert, Space, Typography } from 'antd';
import type { WasteTicketCheckDto, WasteTicketFileDto } from '@technic/contracts';

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
 * Полоса замечаний. Красным — то, что мешает деньгам, жёлтым — то, что мешает порядку. Снятое
 * замечание не исчезает, а становится серым: человек должен видеть, что расхождение было и кто его
 * принял, иначе следующий разбирающий начнёт с нуля.
 */
export function ChecksStrip({
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
      {checks.map((check) => (
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
        />
      ))}
    </Space>
  );
}
