/**
 * D-056 (tribusca-control DECISIONS.md): finalized engines run four daily
 * cycles at 06h, 10h, 14h and 18h, Brasília time. Each source keeps its own
 * minute inside the cycle hour so the cycles do not start every connector at
 * the same instant. Historical backfill is a separate flow, not covered here.
 */
export const D056_TIMEZONE = 'America/Sao_Paulo';
export const D056_HOURS = '6,10,14,18';

export function d056Cron(minute: number): string {
  if (!Number.isSafeInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('D-056 cycle minute must be an integer between 0 and 59.');
  }
  return `${minute} ${D056_HOURS} * * *`;
}

export interface SchedulePolicyEntry {
  code: string;
  cron: string;
  /** Schedule before D-056 was applied; used by the rollback of the alignment script. */
  previousCron: string;
}

/**
 * Sources under D-056. DOE-SP and DOE-SP legacy are governed by their own
 * front and are deliberately not listed.
 */
export const D056_SCHEDULES: readonly SchedulePolicyEntry[] = [
  { code: 'dou', cron: d056Cron(0), previousCron: '0 8,12,16,20 * * *' },
  { code: 'sped', cron: d056Cron(5), previousCron: '0 * * * *' },
  { code: 'nfe-encat', cron: d056Cron(10), previousCron: '0 * * * *' },
  { code: 'cgibs', cron: d056Cron(15), previousCron: '0 * * * *' },
  { code: 'rfb-normas', cron: d056Cron(20), previousCron: '0 * * * *' },
  { code: 'confaz', cron: d056Cron(35), previousCron: '35 * * * *' },
];

export function d056ScheduleFor(code: string): string {
  const entry = D056_SCHEDULES.find((item) => item.code === code);
  if (!entry) throw new Error(`Source ${code} is not governed by D-056.`);
  return entry.cron;
}
