const WEEKDAY = new Map([
  ['Sun', 0],
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
]);

interface CronField {
  matches(value: number): boolean;
  wildcard: boolean;
}

function parseInteger(
  value: string,
  min: number,
  max: number,
  fieldName: string,
): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `Invalid ${fieldName} cron token: ${value}`,
    );
  }

  const parsed = Number(value);

  if (parsed < min || parsed > max) {
    throw new Error(
      `${fieldName} cron value out of range: ${value}`,
    );
  }

  return parsed;
}

function parseField(
  expression: string,
  min: number,
  max: number,
  fieldName: string,
  normalize: (value: number) => number = (value) =>
    value,
): CronField {
  const allowed = new Set<number>();
  const wildcard = expression === '*';

  for (const segment of expression.split(',')) {
    const [rangeExpression, stepExpression] =
      segment.split('/');

    if (!rangeExpression) {
      throw new Error(
        `Invalid ${fieldName} cron field`,
      );
    }

    const step =
      stepExpression === undefined
        ? 1
        : parseInteger(
            stepExpression,
            1,
            max - min + 1,
            `${fieldName} step`,
          );

    let start: number;
    let end: number;

    if (rangeExpression === '*') {
      start = min;
      end = max;
    } else if (rangeExpression.includes('-')) {
      const [startExpression, endExpression] =
        rangeExpression.split('-');

      if (!startExpression || !endExpression) {
        throw new Error(
          `Invalid ${fieldName} cron range: ${rangeExpression}`,
        );
      }

      start = parseInteger(
        startExpression,
        min,
        max,
        fieldName,
      );
      end = parseInteger(
        endExpression,
        min,
        max,
        fieldName,
      );

      if (start > end) {
        throw new Error(
          `Invalid ${fieldName} cron range: ${rangeExpression}`,
        );
      }
    } else {
      start = parseInteger(
        rangeExpression,
        min,
        max,
        fieldName,
      );
      end = start;
    }

    for (
      let value = start;
      value <= end;
      value += step
    ) {
      allowed.add(normalize(value));
    }
  }

  return {
    wildcard,
    matches: (value) => allowed.has(normalize(value)),
  };
}

function zonedParts(
  date: Date,
  timeZone: string,
): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const formatter = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone,
      minute: '2-digit',
      hour: '2-digit',
      day: '2-digit',
      month: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    },
  );

  const parts = formatter.formatToParts(date);
  const values = new Map(
    parts.map((part) => [
      part.type,
      part.value,
    ]),
  );

  const weekday =
    WEEKDAY.get(values.get('weekday') ?? '');

  if (weekday === undefined) {
    throw new Error(
      `Could not resolve weekday for timezone ${timeZone}`,
    );
  }

  return {
    minute: Number(values.get('minute')),
    hour: Number(values.get('hour')),
    dayOfMonth: Number(values.get('day')),
    month: Number(values.get('month')),
    dayOfWeek: weekday,
  };
}

export function floorToUtcMinute(
  date: Date,
): Date {
  const result = new Date(date);
  result.setUTCSeconds(0, 0);
  return result;
}

export function isCronDue(
  expression: string,
  date: Date,
  timeZone: string,
): boolean {
  const fields = expression
    .trim()
    .split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must contain 5 fields: ${expression}`,
    );
  }

  const [
    minuteExpression,
    hourExpression,
    dayOfMonthExpression,
    monthExpression,
    dayOfWeekExpression,
  ] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minute = parseField(
    minuteExpression,
    0,
    59,
    'minute',
  );
  const hour = parseField(
    hourExpression,
    0,
    23,
    'hour',
  );
  const dayOfMonth = parseField(
    dayOfMonthExpression,
    1,
    31,
    'day of month',
  );
  const month = parseField(
    monthExpression,
    1,
    12,
    'month',
  );
  const dayOfWeek = parseField(
    dayOfWeekExpression,
    0,
    7,
    'day of week',
    (value) => (value === 7 ? 0 : value),
  );

  const current = zonedParts(
    date,
    timeZone,
  );

  if (
    !minute.matches(current.minute) ||
    !hour.matches(current.hour) ||
    !month.matches(current.month)
  ) {
    return false;
  }

  const domMatches = dayOfMonth.matches(
    current.dayOfMonth,
  );
  const dowMatches = dayOfWeek.matches(
    current.dayOfWeek,
  );

  if (dayOfMonth.wildcard) {
    return dowMatches;
  }

  if (dayOfWeek.wildcard) {
    return domMatches;
  }

  return domMatches || dowMatches;
}
