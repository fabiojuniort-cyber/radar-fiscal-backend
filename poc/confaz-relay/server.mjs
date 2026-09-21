import server from './testable-server.mjs';

const port = Number(process.env.PORT ?? '8080');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

server.listen(port, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      event: 'relay_started',
      port,
      origin: 'https://www.confaz.fazenda.gov.br',
    }),
  );
});

function shutdown(signal) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      event: 'shutdown_requested',
      signal,
    }),
  );
  server.close();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
