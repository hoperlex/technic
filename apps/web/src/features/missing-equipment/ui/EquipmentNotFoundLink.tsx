import { useState } from 'react';
import { Alert, Button, Space, Typography } from 'antd';
import { CustomerServiceOutlined } from '@ant-design/icons';
import type { OfficeEquipmentDto } from '@technic/contracts';
import { subjectCheckTitle } from '@entities/office-equipment-candidate';
import { SupportContactsModal } from '../../../components/SupportContactsModal';
import { useCandidateIntake } from '../../../auth/candidateIntake';
import { QuickCreateEquipmentModal } from './QuickCreateEquipmentModal';
import { ReportEquipmentModal } from './ReportEquipmentModal';
import type { EquipmentCandidateDraft } from '../model/draft';

/**
 * Текст обращения, собранный за человека: что искали и где стоит техника. Пишется он не в портале
 * (переписки в нём нет, ADR 0077), а в мессенджере поддержки, поэтому контекст показывается
 * готовым к копированию — иначе первым ответом поддержки будет «а что именно вы искали?».
 *
 * Строки, которых портал не знает, не печатаются вовсе: пустое «Объект: —» в обращении хуже, чем
 * его отсутствие, — оно выглядит ответом, которого никто не давал.
 */
function supportText(search: string, objectName: string | undefined): string {
  return [
    'Не нашёл технику в справочнике портала — не могу завести заявку на обслуживание.',
    search.trim() ? `Искал: ${search.trim()}` : null,
    objectName ? `Объект: ${objectName}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Тупик «нужной техники нет в справочнике» под полем выбора единицы (этап 7, Р40; план
 * `docs/office-equipment-candidate-plan.md`, §9).
 *
 * ВЕТВЕЙ ТРИ, И РАЗЛИЧАЕТ ИХ НЕ РОЛЬ, А ТО, ЧТО ЧЕЛОВЕКУ РАЗРЕШЕНО СДЕЛАТЬ С ЭТИМ ТУПИКОМ.
 *
 *   1. `officeEquipment.write` — карточка заводится здесь же, не выходя из заявки. Сегодняшнее окно
 *      без единого изменения: тот, кто ведёт справочник, знает все одиннадцать реквизитов учёта.
 *   2. иначе `officeEquipment.propose` — окно «Сообщить об аппарате»: шесть реквизитов наблюдения,
 *      которые проходят проверку и только решением человека с `write` становятся карточкой (Р1).
 *      Порядок веток именно такой: у проверяющего есть оба права сразу, и сообщать самому себе о
 *      технике, которую он же и заводит, ему незачем.
 *   3. иначе — сегодняшний текст обращения в техподдержку. Ветка не сокращается до второй: право
 *      `propose` до выпуска B не выдано никому, и без третьей ветви тупик остался бы вовсе без
 *      выхода у всех.
 *
 * **Почему заказчику показана техподдержка, а не контакт «оператора вашей площадки».** Такого
 * контакта в портале не существует: надстройка роли (ADR 0086) область учётки не меняет, и связи
 * «оператор ↔ площадка» в данных нет — есть лишь ничем не гарантированное пересечение объектов.
 * При централизованном операторе «оператор вашей площадки» назвал бы одного человека всей
 * компании, при нескольких — список без признака, кому писать; вдобавок это была бы новая ручка,
 * раздающая ФИО и телефоны сотрудников каждому, кто видит модуль. Обещание такого контакта
 * отменено критикой К3 плана, и восстанавливать его догадкой нельзя: понадобится настоящий
 * адресат — его заводят данными, отдельной таблицей «оператор ↔ объект», как у вывоза мусора.
 */
export function EquipmentNotFoundLink({
  canCreate,
  search,
  objectName,
  draft,
  onCreated,
  onReported,
}: {
  /** Есть право вести справочник (`officeEquipment.write`) — тогда карточка заводится здесь. */
  canCreate: boolean;
  /** Что человек набирал в поле выбора техники — контекст обращения в поддержку. */
  search: string;
  /** Площадка учётки, когда она одна и её можно назвать; иначе объект называет сам человек. */
  objectName?: string;
  /** Уже заявленный аппарат: окно открывают повторно, чтобы поправить сообщение до отправки. */
  draft: EquipmentCandidateDraft | null;
  /** Заведённой единицей заполняется поле «Техника» формы заявки. */
  onCreated: (equipment: OfficeEquipmentDto) => void;
  /**
   * Заявленный аппарат уходит в форму заявки черновиком: отправит его «Сохранить» самой заявки.
   * `null` — сообщение убрали, не отправив: человек всё-таки нашёл единицу либо передумал.
   */
  onReported: (draft: EquipmentCandidateDraft | null) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const { canPropose } = useCandidateIntake();
  const text = supportText(search, objectName);

  // Ветка считается один раз и наверху: разложенная по трём `onClick` и трём условиям показа, она
  // разъехалась бы — окно открывалось бы одно, а подпись под полем обещала бы другое.
  const branch = canCreate ? 'create' : canPropose ? 'report' : 'support';

  const openBranch = () => {
    if (branch === 'create') setCreateOpen(true);
    else if (branch === 'report') setReportOpen(true);
    else setHintOpen((prev) => !prev);
  };

  return (
    <div style={{ marginTop: -12, marginBottom: 16 }}>
      <Button type="link" size="small" style={{ padding: 0 }} onClick={openBranch}>
        Не нашли технику?
      </Button>

      {/* Подсказка разворачивается по нажатию, а не висит под полем всегда: у большинства заявок
          техника находится с первой буквы, и постоянный блок про поддержку читался бы как отказ. */}
      {branch === 'support' && hintOpen && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 8 }}
          title="Карточки нет в справочнике"
          description={
            <>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                Карточки заводит ответственный за оргтехнику. Напишите в техподдержку — карточку
                заведут, и заявку вы подадите по ней.
              </Typography.Paragraph>
              <Typography.Paragraph
                copyable={{ text }}
                style={{ whiteSpace: 'pre-line', marginBottom: 8 }}
              >
                {text}
              </Typography.Paragraph>
              <Button icon={<CustomerServiceOutlined />} onClick={() => setSupportOpen(true)}>
                Написать в техподдержку
              </Button>
            </>
          }
        />
      )}

      {branch === 'create' && (
        <QuickCreateEquipmentModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={onCreated}
        />
      )}
      {/* ПЛАШКА ЗАЯВЛЕННОГО — под тем же полем и до отправки (§9). Она отвечает на вопрос, который
          иначе остался бы без ответа вовсе: поле «Какой аппарат» пусто, потому что аппарата в
          справочнике нет, — и без плашки человек видел бы пустое обязательное поле и не знал, ушло
          его сообщение в заявку или нет. Правится оно тем же окном: сообщение ещё никуда не
          отправлено, и «поправить» здесь дешевле, чем заводить заявку заново. */}
      {branch === 'report' && draft && (
        <Alert
          type="success"
          showIcon
          style={{ marginTop: 8 }}
          title={`Аппарат на проверке: ${subjectCheckTitle(draft.input)}`}
          description={
            <>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                {[draft.typeName, draft.site.objectLabel, draft.input.location]
                  .filter(Boolean)
                  .join(' · ')}
                . Уйдёт вместе с заявкой — карточку заведёт тот, кто ведёт справочник.
              </Typography.Paragraph>
              <Space size={8}>
                <Button size="small" onClick={() => setReportOpen(true)}>
                  Поправить
                </Button>
                <Button size="small" type="link" onClick={() => onReported(null)}>
                  Убрать
                </Button>
              </Space>
            </>
          }
        />
      )}

      {branch === 'report' && (
        <ReportEquipmentModal
          open={reportOpen}
          draft={draft}
          onClose={() => setReportOpen(false)}
          onFilled={onReported}
        />
      )}
      {branch === 'support' && (
        /* То же окно контактов, что открывает каркас портала: другого канала поддержки нет, и
           заводить его ради одного тупика значило бы обещать ответ там, где его никто не читает. */
        <SupportContactsModal open={supportOpen} onClose={() => setSupportOpen(false)} />
      )}
    </div>
  );
}
