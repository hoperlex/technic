import type { Dispatch, SetStateAction } from 'react';
import { Checkbox, Select, Space } from 'antd';
import {
  type CredentialTypeCode,
  credentialTypeShortLabels,
  type DriverDocumentSet,
} from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';

/**
 * Отбор справочника водителей: комплект документов, должность, категория и архив.
 *
 * Вынесено из вкладки тем же порядком, что и отбор техники (`VehicleFilters`): каждый отбор живёт
 * дважды — полосой на десктопе и описанием для шита на телефоне (ADR 0030), — и рядом с формой
 * карточки, документами и мутациями эта пара терялась. Списки модуль не запрашивает: те же
 * категории стоят в карточке, и второй запрос означал бы два ответа на один вопрос.
 */

interface Option {
  value: string;
  label: string;
}

/** Отборы вкладки в параметрах списка; страница и сортировка сюда не заходят. */
export interface DriverFilterParams {
  documents?: DriverDocumentSet;
  jobTitle?: string;
  categoryId?: string;
  includeDeleted?: string;
}

export interface DriverFiltersDeps<P extends DriverFilterParams> {
  params: P;
  setParams: Dispatch<SetStateAction<P>>;
  documentSetOptions: Option[];
  jobTitleOptions: Option[];
  filterCategoryOptions: Option[];
  /** Вид документа, названный должностью: от него зависит подпись поля категории. */
  filterType: CredentialTypeCode;
  canSeeArchive: boolean;
  setDocuments: (v: DriverDocumentSet | undefined) => void;
  setJobTitle: (v: string | undefined) => void;
  setCategory: (v: string | undefined) => void;
}

export function useDriverFilters<P extends DriverFilterParams>({
  params,
  setParams,
  documentSetOptions,
  jobTitleOptions,
  filterCategoryOptions,
  filterType,
  canSeeArchive,
  setDocuments,
  setJobTitle,
  setCategory,
}: DriverFiltersDeps<P>) {
  /**
   * Комплект документов, должность и категория — три вопроса к справочнику. Первый: путевой лист
   * печатает СНИЛС, номер удостоверения и дату его выдачи, и половина работы со справочником —
   * дозаполнить тех, у кого чего-то нет; обратное значение нужно не реже — «кем можно закрывать
   * рейсы». Второй пришёл со вторым видом документа (ADR 0095): «что с бумагами у машинистов»
   * спрашивают отдельно от водителей, и лишние колонки этому мешают. Третий появился, когда
   * категория перестала сужать отбор под машину (ADR 0055): «кого можно посадить за седельный
   * тягач» спрашивают здесь, и глазами по списку это не считается.
   *
   * Категория в фильтре названа буквой с описанием — тем же списком, что и в карточке: искать её
   * будут по букве из удостоверения, а не по формулировке правил. Список — того вида документа,
   * который назвала должность: буквы у видов совпадают, и общий перечень предлагал бы выбрать
   * категорию, которой у отобранных людей быть не может.
   */
  const filters = (
    <Space wrap>
      <Select<DriverDocumentSet>
        allowClear
        placeholder="Комплект документов"
        style={{ width: 200 }}
        options={documentSetOptions}
        value={params.documents}
        onChange={setDocuments}
      />
      <Select<string>
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Должность"
        style={{ width: 220 }}
        options={jobTitleOptions}
        value={params.jobTitle}
        onChange={setJobTitle}
      />
      <Select<string>
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder={`Категория ${credentialTypeShortLabels[filterType]}`}
        style={{ width: 220 }}
        options={filterCategoryOptions}
        value={params.categoryId}
        onChange={setCategory}
      />
      {canSeeArchive ? (
        <Checkbox
          checked={params.includeDeleted === 'true'}
          onChange={(e) =>
            setParams((p) => ({
              ...p,
              includeDeleted: e.target.checked ? 'true' : undefined,
              page: 1,
            }))
          }
        >
          Показать архив
        </Checkbox>
      ) : null}
    </Space>
  );

  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'documents',
      label: 'Комплект документов',
      value: params.documents,
      options: documentSetOptions,
      placeholder: 'Все',
      onChange: (v) => setDocuments(v as DriverDocumentSet | undefined),
    },
    {
      kind: 'select',
      key: 'jobTitle',
      label: 'Должность',
      value: params.jobTitle,
      options: jobTitleOptions,
      placeholder: 'Любая',
      onChange: (v) => setJobTitle(v as string | undefined),
    },
    {
      kind: 'select',
      key: 'categoryId',
      label: `Категория ${credentialTypeShortLabels[filterType]}`,
      value: params.categoryId,
      options: filterCategoryOptions,
      placeholder: 'Любая',
      onChange: (v) => setCategory(v as string | undefined),
    },
    ...(canSeeArchive
      ? [
          {
            kind: 'toggle' as const,
            key: 'includeDeleted',
            label: 'Показывать архив',
            value: params.includeDeleted === 'true',
            onChange: (checked: boolean) =>
              setParams((p) => ({ ...p, includeDeleted: checked ? 'true' : undefined, page: 1 })),
          },
        ]
      : []),
  ];
  return { filters, mobileFilters };
}
