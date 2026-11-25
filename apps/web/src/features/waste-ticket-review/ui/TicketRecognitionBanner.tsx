import { Alert } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { ticketRecognitionHealthQuery } from '@entities/waste-ticket';

/**
 * Баннер недоступности распознавания (ADR 0114, Р29).
 *
 * Он существует ради одного свойства: **молчащее распознавание неотличимо от «талоны в порядке»**.
 * Заявки закрываются, талоны прикладываются, замечаний нет — и это выглядит как спокойный день, а
 * не как сломанный сервис. Поэтому состояние спрашивается отдельной ручкой и показывается там же,
 * где человек ждёт замечаний: над карточкой заявки и над реестром.
 *
 * Текста два, и разница между ними — не тон, а обещание. Временный сбой действительно разберётся
 * сам: задачи копятся, воркер повторит. Терминальный (отказ доступа, неверный токен, сломанный
 * конфиг) не разберётся никогда, и обещать автоматическое восстановление там значит врать —
 * человек будет ждать, вместо того чтобы позвать администратора.
 */
export function TicketRecognitionBanner({ enabled }: { enabled: boolean }) {
  const { data } = useQuery(ticketRecognitionHealthQuery(enabled));
  if (!data || data.state === 'ok') return null;

  const since = data.since ? new Date(data.since).toLocaleString('ru-RU') : null;

  // Выключенный модуль — не сбой, а порядок работы: талоны разбирает человек. Но сказать об этом
  // обязательно, иначе пустая таблица и «расхождений нет» читаются как «машина проверила, всё
  // сошлось» — то есть ровно наоборот.
  if (data.state === 'disabled') {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="Распознавание талонов выключено"
        // A manual ticket settles only a scan that was read and had no ticket found (snow-removal
        // plan, §3.2): unread scans wait for recognition, so the banner names that way out first.
        description="Приложенные сканы ждут распознавания: включите его и нажмите «Перераспознать» у непрочитанных файлов. Талон вручную заводят только для прочитанного скана, на котором талон не найден."
      />
    );
  }

  if (data.state === 'unconfigured') {
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 12 }}
        title="Распознавание талонов не настроено"
        description={
          <>
            {data.code ? `Отказ доступа (${data.code})` : 'Сервис отвергает запросы портала'}
            {since ? ` с ${since}` : ''}. Нужен администратор: автоматического восстановления не
            будет. После восстановления нажмите «Перераспознать» у непрочитанных файлов — заявки
            закрываются как обычно.
          </>
        }
      />
    );
  }

  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      title="Распознавание талонов временно недоступно"
      description={
        <>
          {since ? `С ${since}. ` : ''}
          {data.waiting > 0 ? `Ждут разбора: ${data.waiting}. ` : ''}
          Заявки закрываются как обычно, талоны будут проверены автоматически, как только сервис
          вернётся.
        </>
      }
    />
  );
}
