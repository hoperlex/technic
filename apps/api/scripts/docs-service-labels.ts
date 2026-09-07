import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVICE_ASSIGNER_TRANSITIONS,
  SERVICE_EXECUTOR_TRANSITIONS,
  SERVICE_FILE_KINDS,
  SERVICE_HOLD_TRANSITIONS,
  SERVICE_OPERATOR_TRANSITIONS,
  SERVICE_REQUEST_KINDS,
  SERVICE_REQUEST_STATUSES,
  SERVICE_WAITING_ON,
  type ServiceRequestStatus,
  isServiceFileKindAttachable,
  isServiceFileKindVisible,
  serviceFileKindLabels,
  serviceRequestKindLabels,
  serviceRequestStatusLabels,
  serviceWaitingOnLabels,
} from '@technic/contracts';

/**
 * Словарь названий модуля «Орг.техника» для документов — этап Э1 плана
 * `docs/office-equipment-requester-guide-update-plan.md` (субзадача С7, решение Р3).
 *
 * ЗАЧЕМ. Памятка заявителю держала подписи статусов своей константой, и разошлась она молча:
 * `assigned` и `estimate_review` переименовывались дважды, а документ этого не заметил (находка Н7
 * плана). Генератор памятки читает теперь `docs/labels/service-request-labels.json` и **не
 * содержит ни одной подписи своей строкой**, а этот скрипт — единственное место, где файл
 * появляется.
 *
 * ПОЧЕМУ ФАЙЛ, А НЕ ИМПОРТ КОНТРАКТОВ ПРЯМО В ГЕНЕРАТОР. Генераторы документов — `.mjs` на голом
 * node, и запуск памятки не должен требовать ни `tsx`, ни workspace-резолва зависимостей API.
 * Второе, и более важное: JSON виден в диффе. Переименование статуса становится заметно в ревью
 * документа, а не только в ревью кода, и человек, правящий памятку, видит, что подпись изменилась.
 *
 * ФАЙЛ РУКАМИ НЕ ПРАВИТСЯ. Его сверяет с контрактами страж `test/docs-service-labels.test.ts`:
 * расхождение роняет `pnpm check`. Правка «только подписи в JSON» прожила бы ровно до следующего
 * прогона тестов — и это дешевле, чем документ, разошедшийся с порталом на полгода.
 *
 * ТАБЛИЦЫ ПЕРЕХОДОВ ПЕРЕЧИСЛЕНЫ ПОИМЁННО, И ЭТО ОСОЗНАННО. Их состав меняется вместе с циклом: за
 * сутки после первой сборки этого файла из контрактов исчезла `SERVICE_IT_TRANSITIONS` (виза ИТ
 * упразднена, таблица стояла пустой). Импорт поимённо ломает сборку словаря на такой правке —
 * шумно, зато сразу; собранный же рефлексией список молча потерял бы коридор и объявил бы мёртвым
 * живой статус.
 *
 * ЖИВОЙ СТАТУС СЧИТАЕТСЯ, А НЕ ПЕРЕЧИСЛЯЕТСЯ. В словаре статусов четыре мёртвых значения
 * (`it_approved`, `assigned`, `diagnostics`, `estimate_review`): заявок в них не бывает, но подписи
 * нужны ИСТОРИИ — строка «Новая → Назначена» от 20.08 правдива. Памятке же нужны только живые, и
 * список их здесь не записан: он выводится достижимостью из `new` по объединению всех таблиц
 * переходов, какие есть в контрактах на день сборки. Записанный списком, он пережил бы упразднение очередного статуса — ровно так и
 * появляется документ, обещающий состояние, в которое заявка больше не попадает.
 */

const TRANSITIONS = [
  SERVICE_EXECUTOR_TRANSITIONS,
  SERVICE_ASSIGNER_TRANSITIONS,
  SERVICE_HOLD_TRANSITIONS,
  SERVICE_OPERATOR_TRANSITIONS,
];

/** Статусы, достижимые из «Новой» хотя бы одной стороной цикла. Порядок — порядок enum. */
function liveStatuses(): ServiceRequestStatus[] {
  const reachable = new Set<ServiceRequestStatus>(['new']);
  for (let grew = true; grew;) {
    grew = false;
    for (const from of [...reachable]) {
      for (const table of TRANSITIONS) {
        for (const to of table[from] ?? []) {
          if (!reachable.has(to)) {
            reachable.add(to);
            grew = true;
          }
        }
      }
    }
  }
  return SERVICE_REQUEST_STATUSES.filter((status) => reachable.has(status));
}

export interface ServiceLabelsFile {
  readonly $comment: string;
  readonly kinds: readonly { value: string; label: string }[];
  readonly statuses: readonly { value: string; label: string; live: boolean }[];
  readonly waitingOn: readonly { value: string; label: string }[];
  readonly fileKinds: readonly {
    value: string;
    label: string;
    visibleToRequester: boolean;
    attachableByRequester: boolean;
  }[];
}

export function buildServiceLabels(): ServiceLabelsFile {
  const live = new Set(liveStatuses());
  return {
    $comment:
      'Собирается `pnpm --filter @technic/api docs:labels` из packages/contracts. ' +
      'Руками не правится: расхождение с контрактами роняет apps/api/test/docs-service-labels.test.ts.',
    kinds: SERVICE_REQUEST_KINDS.map((value) => ({
      value,
      label: serviceRequestKindLabels[value],
    })),
    statuses: SERVICE_REQUEST_STATUSES.map((value) => ({
      value,
      label: serviceRequestStatusLabels[value],
      live: live.has(value),
    })),
    waitingOn: SERVICE_WAITING_ON.map((value) => ({ value, label: serviceWaitingOnLabels[value] })),
    fileKinds: SERVICE_FILE_KINDS.map((value) => ({
      value,
      label: serviceFileKindLabels[value],
      visibleToRequester: isServiceFileKindVisible(value, 'requester'),
      /**
       * «Хоть когда-нибудь» — вопрос памятки: она пишет, что заявитель прикладывает к заявке, а не
       * в каком состоянии кнопка доступна и не чей это ход. Состояние держит
       * `attachableServiceFileKinds`, сторону — `canAttachServiceFileSide` (Р3 плана аудита
       * исполнителей), и повторять их здесь незачем: у заявителя стороны цикла не бывает вовсе, а
       * потолок аудитории отвечает на вопрос памятки целиком.
       */
      attachableByRequester: isServiceFileKindAttachable(value, 'requester'),
    })),
  };
}

export const SERVICE_LABELS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/labels/service-request-labels.json',
);

/** Ровно тот текст, который лежит в файле: `\n` в конце — чтобы `prettier --check` был доволен. */
export function serviceLabelsText(): string {
  return `${JSON.stringify(buildServiceLabels(), null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(dirname(SERVICE_LABELS_PATH), { recursive: true });
  writeFileSync(SERVICE_LABELS_PATH, serviceLabelsText());
  console.log(SERVICE_LABELS_PATH);
}
