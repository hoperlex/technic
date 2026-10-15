import { writeFileSync } from 'node:fs';
import process from 'node:process';

/** Vitest's JSON reporter omits unhandled errors, so the DB gate records them separately. */
export default class DbUnhandledReporter {
  onTestRunEnd(_modules, unhandledErrors) {
    const reportPath = process.env.TECHNIC_DB_UNHANDLED_REPORT;
    if (!reportPath) throw new Error('TECHNIC_DB_UNHANDLED_REPORT is required');
    writeFileSync(
      reportPath,
      JSON.stringify(
        unhandledErrors.map((error) => ({
          code: typeof error.code === 'string' ? error.code : null,
          message: typeof error.message === 'string' ? error.message : String(error),
        })),
      ),
    );
  }
}
