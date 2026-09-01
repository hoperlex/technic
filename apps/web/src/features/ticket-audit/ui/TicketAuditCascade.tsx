import { Space, Tooltip, Typography } from 'antd';
import type { TicketAuditCascade as Cascade } from '@technic/contracts';
import { CASCADE_OUTCOMES_NOTE, cascadeFilledView, cascadeOutcomeView } from '../model/numbers';
import { Ratio } from './Ratio';
import { StatLine } from './StatLine';

/**
 * Блок «Каскад» (§5.2 плана): что дала вторая ступень и чем кончились споры.
 *
 * Отдельно от таблицы когорт намеренно: это числа не про конфигурацию, а про сам механизм
 * эскалации, и стоящие столбцом рядом с долями когорт они читались бы как ещё одна их колонка.
 */
export function TicketAuditCascadeBlock({ cascade }: { cascade: Cascade }) {
  return (
    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
      <Typography.Text strong>
        Каскад
        {cascade.runsWithEscalation > 0
          ? ` (эскалация включалась на ${cascade.runsWithEscalation} разборах)`
          : ''}
      </Typography.Text>
      <CascadeBody cascade={cascade} />
    </Space>
  );
}

/**
 * Тело блока. Пустота названа словами, а не нулями: «эскалация не включалась» и «включалась, но
 * ничего не нашла» — разные ответы, а шесть нулей столбцом читаются как второй.
 */
function CascadeBody({ cascade }: { cascade: Cascade }) {
  if (cascade.runsWithEscalation === 0)
    return (
      <Typography.Text type="secondary">
        Эскалация в этот период не включалась: все разборы кончились на первом проходе
      </Typography.Text>
    );

  return (
    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
      <StatLine
        label="пустых после первого прохода"
        hint="Полей, которые первый проход не прочитал, — среди разборов, где включалась вторая ступень"
      >
        <Typography.Text>{cascade.emptyAfterPrimary}</Typography.Text>
      </StatLine>
      <StatLine
        label="заполнено вторым проходом"
        hint="Из пустот первого прохода вторая ступень назвала значение. Заполнено — не значит верно: правильность подтверждает не каскад, а человек"
      >
        <Ratio view={cascadeFilledView(cascade)} />
      </StatLine>
      <StatLine
        label="создано споров"
        hint="Проходы прочитали поле по-разному, и портал попросил человека решить"
      >
        <Typography.Text>{cascade.disputes}</Typography.Text>
      </StatLine>
      <DisputeOutcomes cascade={cascade} />
    </Space>
  );
}

/**
 * Исходы споров. Подсказка объясняет, почему они операторские, — и почему слова «арбитраж» здесь
 * нет: назвать их так значило бы приписать им доказательную силу независимой проверки, которой у
 * спора каскада не бывает по устройству портала.
 */
function DisputeOutcomes({ cascade }: { cascade: Cascade }) {
  if (cascade.disputes === 0)
    return (
      <Typography.Text type="secondary" style={{ paddingLeft: 16 }}>
        Споров не было: проходы читали поля одинаково
      </Typography.Text>
    );

  const outcomes: { label: string; hint: string; value: number }[] = [
    {
      label: 'оператор выбрал первый вариант',
      hint: 'Человек оставил значение первого прохода',
      value: cascade.disputeOutcomes.primary,
    },
    {
      label: 'оператор выбрал второй',
      hint: 'Человек оставил значение второй ступени',
      value: cascade.disputeOutcomes.escalation,
    },
    {
      label: 'оператор ввёл третье значение',
      hint: 'Ошиблись оба прохода: человек назвал значение, которого не предлагал ни один',
      value: cascade.disputeOutcomes.third,
    },
    {
      label: 'пока не решено',
      hint: 'Спор ещё висит: талон не подтверждён, и исход у поля появится позже',
      value: cascade.disputeOutcomes.unresolved,
    },
  ];

  return (
    <Space orientation="vertical" size={4} style={{ width: '100%', paddingLeft: 16 }}>
      {outcomes.map((outcome) => (
        <StatLine key={outcome.label} label={outcome.label} hint={outcome.hint}>
          <Ratio view={cascadeOutcomeView(outcome.value, cascade.disputes)} />
        </StatLine>
      ))}
      <Tooltip title={CASCADE_OUTCOMES_NOTE}>
        <Typography.Text type="secondary">
          — исходы операторские: независимой проверки у спора каскада не бывает
        </Typography.Text>
      </Tooltip>
    </Space>
  );
}
