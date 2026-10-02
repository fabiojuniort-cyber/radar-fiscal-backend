import 'dotenv/config';

import { resolveDoeSpLegacySourceLimits } from '../../modules/collection/doe-sp-legacy.connector.js';
import { runDoeSpLegacyPilot } from '../../modules/collection/doe-sp-legacy.pilot.js';

/*
 * Dry pilot of the legacy DOE-SP archive (Issue #20). Reads the official portal
 * only; writes nothing to the database (no DATABASE_URL needed).
 *
 *   npm run doe-sp-legacy:pilot -- --browse=1988-03-02,1995-09-06 --compare=2010-03-03 [--cadernos=ex1,ex2,ex3]
 *
 * Prints one DOE_SP_LEGACY_PILOT_PAGE line per page (public link, outcome,
 * matched terms; never the page text) and a final DOE_SP_LEGACY_PILOT_SUMMARY.
 */

function dates(flag: string): string[] {
  const value = process.argv.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3);
  return value ? value.split(',').map((date) => date.trim()).filter(Boolean) : [];
}

const browseDates = dates('browse');
const compareDates = dates('compare');
const cadernos = dates('cadernos');
if (!browseDates.length && !compareDates.length) {
  console.error('Pass --browse=YYYY-MM-DD[,...] and/or --compare=YYYY-MM-DD[,...] (compare: 2003 on).');
  process.exit(1);
}

const limits = resolveDoeSpLegacySourceLimits();
try {
  const report = await runDoeSpLegacyPilot({
    browseDates,
    compareDates,
    ...(cadernos.length ? { cadernos } : {}),
    client: { minRequestIntervalMs: limits.minRequestIntervalMs },
    onPage: (page) => console.log('DOE_SP_LEGACY_PILOT_PAGE=' + JSON.stringify(page)),
  });
  for (const day of report.days) {
    console.log('DOE_SP_LEGACY_PILOT_DAY=' + JSON.stringify({ date: day.date, caderno: day.caderno, mode: day.mode, edition: day.edition, counts: day.counts, ...(day.search ? { search: day.search } : {}) }));
  }
  console.log('DOE_SP_LEGACY_PILOT_SUMMARY=' + JSON.stringify({ totals: report.totals, requests: report.requests, downloadedBytes: report.downloadedBytes }));
} catch (error) {
  console.error('DOE_SP_LEGACY_PILOT_FAILED=' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
