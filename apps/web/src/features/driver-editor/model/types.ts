import type dayjs from 'dayjs';

export interface DriverFormValues {
  lastName: string;
  firstName: string;
  middleName?: string;
  snils: string;
  phone?: string;
  email?: string;
  personnelNo?: string;
  comment?: string;
  license?: {
    series?: string;
    number: string;
    issuedOn?: dayjs.Dayjs;
    expiresOn?: dayjs.Dayjs;
    categoryIds?: string[];
  };
}
