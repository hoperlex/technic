import type { Dispatch, SetStateAction } from 'react';
import { Checkbox, Select, Space } from 'antd';
import {
  type CredentialTypeCode,
  credentialTypeShortLabels,
  type DriverDocumentSet,
} from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';

/**
 * Driver registry filters: document completeness, job title, category and archive.
 *
 * Desktop controls and mobile-sheet definitions stay together so both layouts ask the same
 * questions. Dictionaries enter through ports because the card form consumes the same category
 * data and must not create a second source of truth.
 */

interface Option {
  value: string;
  label: string;
}

/** Registry-specific list parameters; paging, sorting and search remain in the list model. */
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
  /** The job title selects the credential dictionary named in the category label. */
  filterType: CredentialTypeCode;
  canSeeArchive: boolean;
  setDocuments: (v: DriverDocumentSet | undefined) => void;
  setJobTitle: (v: string | undefined) => void;
  setCategory: (v: string | undefined) => void;
}

export function useDriverRegistryFilters<P extends DriverFilterParams>({
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
   * Completeness, job title and category answer independent registry questions. Job title also
   * selects the relevant credential type (ADR 0095); category remains advisory rather than an
   * assignment gate (ADR 0055). The filter reuses the form dictionary so equal letters from driver
   * and tractor credentials can never be mixed.
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
