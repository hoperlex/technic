import type dayjs from 'dayjs';

export interface DriverLicenseFormValues {
  series?: string;
  number: string;
  issuedOn?: dayjs.Dayjs;
  expiresOn?: dayjs.Dayjs;
  /** Tractor credentials may legitimately arrive without category data from the staff import. */
  categoryIds?: string[];
  /** Remove every previous credential of this type instead of retaining document history. */
  deletePrevious?: boolean;
}
