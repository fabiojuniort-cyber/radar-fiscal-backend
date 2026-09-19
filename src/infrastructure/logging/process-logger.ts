export interface ProcessLogger {
  info(
    data: Record<string, unknown>,
    message: string,
  ): void;
  warn(
    data: Record<string, unknown>,
    message: string,
  ): void;
  error(
    data: Record<string, unknown>,
    message: string,
  ): void;
  fatal(
    data: Record<string, unknown>,
    message: string,
  ): void;
}

function write(
  level: 'info' | 'warn' | 'error' | 'fatal',
  data: Record<string, unknown>,
  message: string,
): void {
  const record = {
    level,
    time: new Date().toISOString(),
    message,
    ...data,
  };

  const serialized = JSON.stringify(record);

  if (level === 'error' || level === 'fatal') {
    console.error(serialized);
  } else if (level === 'warn') {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

export const processLogger: ProcessLogger = {
  info: (data, message) =>
    write('info', data, message),
  warn: (data, message) =>
    write('warn', data, message),
  error: (data, message) =>
    write('error', data, message),
  fatal: (data, message) =>
    write('fatal', data, message),
};
