import { Button, Checkbox, Space, Tooltip, Typography, Upload } from 'antd';
import { DeleteOutlined, PaperClipOutlined, UploadOutlined } from '@ant-design/icons';

/**
 * Почему «подать прикреплением счёта» недоступно (Р10 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`).
 *
 * Причина и выход одной строкой: счёт подают ВМЕСТО набранного состава — у документной ревизии
 * строк нет вовсе, — и спрячь окно под галочкой набранную смету, она уехала бы молча. Погашенная
 * галочка без этих слов читалась бы как поломка окна.
 */
const DOCUMENT_LOCKED_HINT =
  'Счёт подают вместо набранного состава: у ревизии с документом строк нет вовсе, и спрятать ' +
  'набранное под галочкой значило бы унести его молча. Галочка открыта, пока состав пуст либо это ' +
  'одна услуга количеством один без гарантии и без нулевой цены; уберите лишние строки — либо ' +
  'предъявляйте набранное обычным порядком, по графам.';

/**
 * ТРЕТИЙ СПОСОБ ПОДАЧИ ОБЪЁМА РАБОТ — ЧЕКБОКС, А НЕ ПУНКТ ПЕРЕКЛЮЧАТЕЛЯ (Р2, Р10).
 *
 * Переключатель рядом отвечает на вопрос «как набирать строки», и оба его пункта дают один и тот же
 * результат — строки с суммой. Здесь же не набирают вовсе: ревизия состоит из приложенного счёта,
 * строк у неё нет, а сумма системе до разбора документа неизвестна (ответ В5 заказчика от
 * 11.09.2026). Встань этот способ третьим пунктом того же переключателя — окно обещало бы трём
 * разным вещам одинаковую природу.
 *
 * СУММУ РЕЖИМ НЕ СПРАШИВАЕТ ВОВСЕ, и поля стоимости в нём нет не по забывчивости: подставленный
 * ноль читался бы как «работы бесплатны» (тот же запрет, что у свободной записи), а настоящее
 * значение придёт разбором документа.
 */
export function EstimateDocumentSwitch({
  checked,
  allowed,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  /** Набранное помещается в документную подачу, не теряясь (`fitsFreeMode` у вызывающего). */
  allowed: boolean;
  /** Правка закрыта висящим предъявлением (Р9) — способ подачи тогда тоже не меняют. */
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const box = (
    <Checkbox
      checked={checked}
      disabled={disabled || !allowed}
      onChange={(e) => onChange(e.target.checked)}
    >
      Подать прикреплением счёта
    </Checkbox>
  );
  return (
    <div>
      {/* Подсказка вешается на обёртку, а не на сам `Checkbox`: выключенный ввод событий мыши не
          отдаёт, и тултип на нём не появился бы вовсе — тем же приёмом объяснён запертый пункт
          переключателя режимов. */}
      {allowed ? (
        box
      ) : (
        <Tooltip title={DOCUMENT_LOCKED_HINT}>
          <span>{box}</span>
        </Tooltip>
      )}
      {checked && (
        <div>
          <Typography.Text type="secondary">
            Ревизия соберётся из приложенного документа: строк и суммы у неё нет — их даст разбор
            счёта. Нужна построчная картина раньше — «Ведение» разложит счёт по графам.
          </Typography.Text>
        </div>
      )}
    </div>
  );
}

/**
 * СТРАНИЦЫ СЧЁТА: загрузка до предъявления и список приложенного (Р7).
 *
 * Файл уезжает в хранилище сразу, а связь с заявкой ставит уже команда предъявления — одной
 * транзакцией с ревизией: сервер основанием принимает только догруженный файл, и загрузка «вместе с
 * отправкой» отвечала бы отказом в конце формы.
 *
 * КНОПКА СНЯТИЯ ЕСТЬ ТОЛЬКО ЗДЕСЬ И ТОЛЬКО ДО ПРЕДЪЯВЛЕНИЯ. После него страница становится
 * основанием денежного решения и не снимается никогда (Р6) — там кнопки не будет вовсе; до него
 * ошибка выбора обязана иметь выход, иначе человек, приложивший чужой документ, закроет окно и
 * начнёт заново.
 */
export function EstimateDocumentFiles({
  files,
  uploading,
  disabled = false,
  onUpload,
  onRemove,
}: {
  files: readonly { id: string; name: string }[];
  uploading: boolean;
  disabled?: boolean;
  onUpload: (file: File) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Upload
        multiple
        showUploadList={false}
        disabled={disabled}
        beforeUpload={(file) => {
          onUpload(file);
          // Загрузку ведёт портал сам (сессия → хранилище → подтверждение): встроенный загрузчик
          // antd знал бы только один из трёх шагов.
          return false;
        }}
      >
        <Button icon={<UploadOutlined />} loading={uploading} disabled={disabled}>
          Приложить счёт или скриншот
        </Button>
      </Upload>
      {files.length === 0 ? (
        <Typography.Text type="secondary">
          Документа ещё нет: приложите файл счёта либо его скриншот.
        </Typography.Text>
      ) : (
        files.map((file) => (
          <Space key={file.id} size={8}>
            <PaperClipOutlined />
            <Typography.Text>{file.name}</Typography.Text>
            <Button
              type="link"
              size="small"
              icon={<DeleteOutlined />}
              disabled={disabled}
              aria-label={`Убрать ${file.name}`}
              onClick={() => onRemove(file.id)}
            >
              Убрать
            </Button>
          </Space>
        ))
      )}
    </div>
  );
}
