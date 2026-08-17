import { useState } from 'react';
import { Alert, Modal, Radio, Select, Space, Typography } from 'antd';
import dayjs from 'dayjs';
import {
  READING_EXPORT_KINDS,
  readingExportKindLabels,
  readingExportNeedsVehicle,
  type ReadingExportKind,
} from '@technic/contracts';
import { vehicleReadingsApi } from '@entities/vehicle-reading';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

/**
 * Выбор выгрузки показаний (план «Показания техники», §8, Р18).
 *
 * Окно появилось вместо одной кнопки не ради красоты списка: книг стало шесть, и различаются они не
 * оформлением, а вопросом, на который отвечают, — «сколько прошёл парк за месяцы» и «что было по
 * сменам этой машины» суть разные книги с разными листами. Шесть кнопок в строке инструментов
 * читались бы как шесть кнопок «выгрузить», а выпадающий список без пояснений заставлял бы скачивать
 * наугад: имя варианта не говорит, что внутри. Поэтому каждый вариант подписан строкой состава — по
 * ней и выбирают, не открывая книгу.
 *
 * Шестой — `fleetSummary`, прежняя книга этой самой кнопки. План §8 её не перечисляет, потому что
 * она была до него; убрать её из окна значило бы отнять у людей выгрузку, которой они пользуются
 * сегодня, поэтому она стоит первой и выбрана по умолчанию.
 *
 * **Период не спрашивается.** Он тот, что показан на экране и живёт в адресе (Р29): выгружают то,
 * на что смотрят. Второй период здесь означал бы, что таблица и книга отвечают про разные отрезки,
 * а ссылка «вот этот месяц» перестала бы описывать выгрузку, сделанную по ней же.
 *
 * **Право на ТО окно не проверяет и не подменяет** (Р14а): состав среза решает сервер под
 * `vehicleMaintenance.read`. Портал лишь не обещает того, чего человек не получит, — без права
 * колонки обслуживания в объяснении не называются. Скрывать сам вариант незачем: одометр и
 * моточасы в нём есть у всякого, кому видна вкладка.
 */

const SHOWN_DATE = 'DD.MM.YYYY';

/** Поле выбора машины: формы здесь нет, поэтому подпись связывается с полем вручную, через `id`. */
const VEHICLE_FIELD = 'readings-export-vehicle';

/**
 * Не второе «Выгрузить»: кнопка в строке инструментов задаёт вопрос «какую книгу», эта на него
 * отвечает. Одно слово на обеих читалось бы как «нажми ещё раз».
 */
const OK_TEXT = 'Скачать книгу';

/**
 * Что внутри каждой книги — одной строкой. Названия сюда не переписываются: они приходят из
 * контракта (`readingExportKindLabels`), общие с именем файла, и вторая копия разошлась бы с ним при
 * первой же правке. Здесь только состав, ради которого вариант и выбирают.
 *
 * Записью, а не списком: тип обязывает объяснить каждый вариант перечисления — новый, добавленный
 * на сервере, не проедет в окно немым.
 */
function hints(to: string, maintenanceVisible: boolean): Record<ReadingExportKind, string> {
  const on = dayjs(to).format(SHOWN_DATE);
  return {
    fleetSummary:
      'Строка на машину за весь период: пробег, наработка, топливо и разрывы ряда — ровно то, что в таблице на экране.',
    fleetMonths:
      'Строка на машину, колонки — месяцы периода: видно, в каком месяце машина просела.',
    vehicleJournal:
      'Все смены подряд одним листом: день, смена, кто передал, три счётчика, приросты и пометки аномалий.',
    vehicleMonths: 'То же построчно, но каждый месяц периода — отдельный лист книги.',
    /*
     * Обслуживание называется только тому, кто его получит. Обещать колонки, которые сервер не
     * отдаст, — хуже, чем не назвать их: человек полез бы искать в книге то, чего в ней нет, и
     * решил бы, что выгрузка сломана.
     */
    snapshot: maintenanceVisible
      ? `Последний одометр и моточасы на ${on} с датами снятия, дата последнего ТО и пробег с него.`
      : `Последний одометр и моточасы на ${on} с датами снятия.`,
    fleetJournal:
      'Все показания периода одним листом, по всем машинам сразу. Выгрузка построчная: у длинного периода сервер попросит его сузить.',
  };
}

export interface ExportVehicle {
  id: string;
  label: string;
}

interface Props {
  from: string;
  to: string;
  /**
   * Машины периода — те же строки, что показаны в сводке. Своего запроса окно не делает: список
   * уже загружен экраном, и второй, собранный по другому правилу, предлагал бы выгрузить машину,
   * которой в таблице нет.
   */
  vehicles: readonly ExportVehicle[];
  /** Открытая карточка машины (`?vehicle=`), если окно позвали при ней, — ею предвыбирается список. */
  vehicleId: string | null;
  onClose: () => void;
}

export function ReadingsExportModal({ from, to, vehicles, vehicleId, onClose }: Props) {
  const { can } = useAuth();
  /**
   * Умолчание — та самая книга, которую кнопка «Выгрузить» скачивала до этого окна: человек,
   * пришедший за привычной сводкой, доходит до неё тем же числом нажатий, а не ищет её среди шести.
   */
  const [kind, setKind] = useState<ReadingExportKind>('fleetSummary');
  /**
   * Машина выбирается здесь, а не берётся из открытой карточки.
   *
   * Разбиралось наоборот — «показывать два журнальных варианта только при открытой карточке», — и
   * не годится: карточка машины стоит окном поверх всей страницы (`VehicleReadingCard`), а кнопка
   * выгрузки живёт в строке инструментов под ним. Пока карточка открыта, до кнопки не дотянуться, а
   * закрытие карточки стирает `?vehicle=` из адреса — то есть оба журнальных варианта не показались
   * бы никогда. А списку для выбора взяться откуда: строки сводки уже на экране, и запроса он не
   * стоит. Открытая карточка при этом не пропадает даром — ею список предвыбирается.
   */
  const [vehicle, setVehicle] = useState<string | null>(vehicleId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const composition = hints(to, can('vehicleMaintenance.read'));
  const needsVehicle = readingExportNeedsVehicle(kind);

  /**
   * Чего не хватает варианту. Пусто — вариант годен; иначе строка говорит, чего именно нет, и
   * стоит рядом с самим вариантом: «кнопка не нажимается» без объяснения — это молчаливый отказ.
   */
  const missing = (which: ReadingExportKind): string | null =>
    readingExportNeedsVehicle(which) && vehicles.length === 0
      ? 'Выбирать не из чего: за этот период ни одна машина не работала — расширьте период.'
      : null;

  const blocker = missing(kind) ?? (needsVehicle && !vehicle ? 'Машина не выбрана' : null);

  const download = async () => {
    if (blocker) return;
    setBusy(true);
    setFailure(null);
    try {
      await vehicleReadingsApi.exportBook(kind, {
        from,
        to,
        // Машина уходит только тем вариантам, которым она нужна: лишний `vehicleId` у сводной
        // книги — это просьба, которую сервер обязан либо отвергнуть, либо молча понять по-своему.
        ...(needsVehicle && vehicle ? { vehicleId: vehicle } : {}),
      });
      onClose();
    } catch (e: unknown) {
      /*
       * Отказ остаётся в окне, а не улетает тостом. У построчных выгрузок сервер ставит предел по
       * длине периода (Р31) и отвечает «сузьте период» — это указание, что делать дальше, и читать
       * его надо там же, где выбирают вариант, а не ловить исчезающее сообщение в углу.
       */
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Выгрузка показаний"
      open
      onCancel={onClose}
      onOk={() => void download()}
      okText={OK_TEXT}
      okButtonProps={{ disabled: blocker !== null }}
      cancelText="Отмена"
      confirmLoading={busy}
      width={620}
      centered
      mask={{ closable: false }}
      styles={{ body: { maxHeight: '60dvh', overflowY: 'auto' } }}
    >
      <Space direction="vertical" size={12} style={{ display: 'flex' }}>
        <Typography.Text type="secondary">
          Период — тот же, что на экране: {dayjs(from).format(SHOWN_DATE)} —{' '}
          {dayjs(to).format(SHOWN_DATE)}. Нужен другой — поменяйте его над таблицей.
        </Typography.Text>

        <Radio.Group
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as ReadingExportKind);
            // Прошлый отказ относился к прошлому варианту: «сузьте период» под выбранной сводкой
            // отвечал бы не на тот вопрос.
            setFailure(null);
          }}
        >
          <Space direction="vertical" size={10}>
            {READING_EXPORT_KINDS.map((item) => {
              const lack = missing(item);
              return (
                <Radio key={item} value={item} disabled={lack !== null}>
                  <div>{readingExportKindLabels[item]}</div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {composition[item]}
                  </Typography.Text>
                  {lack && (
                    <div>
                      <Typography.Text type="warning" style={{ fontSize: 12 }}>
                        {lack}
                      </Typography.Text>
                    </div>
                  )}
                </Radio>
              );
            })}
          </Space>
        </Radio.Group>

        {needsVehicle && vehicles.length > 0 && (
          <Space direction="vertical" size={4} style={{ display: 'flex' }}>
            <label htmlFor={VEHICLE_FIELD}>
              <Typography.Text strong>Машина</Typography.Text>
            </label>
            <Select
              id={VEHICLE_FIELD}
              value={vehicle}
              onChange={(next: string) => setVehicle(next)}
              placeholder="Выберите машину"
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              options={vehicles.map((v) => ({ value: v.id, label: v.label }))}
            />
            {!vehicle && (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                Выберите машину: этот журнал строится по одной единице техники.
              </Typography.Text>
            )}
          </Space>
        )}

        {failure && (
          <Alert type="error" showIcon message="Книга не собрана" description={failure} />
        )}
      </Space>
    </Modal>
  );
}
