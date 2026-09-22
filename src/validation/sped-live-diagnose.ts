import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const HOST = 'sped.rfb.gov.br';
const paths = [
  '/',
  '/item/show/274',
  '/projeto/show/274',
  '/item/show/268',
  '/projeto/show/268',
  '/item/show/1196',
  '/projeto/show/1196',
  '/item/show/7950',
  '/pagina/show/7950',
  '/destaques/show/7',
  '/destaques/show/285',
  '/destaques/show/1199',
  '/item/show/1837',
  '/arquivo/show/8016',
  '/arquivo/show/8112',
] as const;

function tcpProbe(address: string, port: number, timeoutMs = 8_000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: address, port, family: 4 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, port, error: 'TCP_TIMEOUT' });
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true, port });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, port, error: error.message, code: error.code });
    });
  });
}

function request(
  scheme: 'http' | 'https',
  path: string,
  timeoutMs = 12_000,
): Promise<Record<string, unknown>> {
  const transport = scheme === 'https' ? https : http;
  return new Promise((resolve) => {
    const req = transport.request({
      protocol: scheme + ':',
      hostname: HOST,
      port: scheme === 'https' ? 443 : 80,
      path,
      method: 'GET',
      family: 4,
      timeout: timeoutMs,
      headers: {
        host: HOST,
        'user-agent': 'RadarFiscal/1.0 (+official-source-monitoring)',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.5',
        connection: 'close',
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        if (total < 96 * 1024) {
          chunks.push(chunk);
          total += chunk.length;
        }
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          scheme,
          path,
          status: res.statusCode,
          location: res.headers.location ?? null,
          contentType: res.headers['content-type'] ?? null,
          bytes: Buffer.byteLength(body),
          hasSped: /SPED|Sistema Público de Escrituração Digital/i.test(body),
          hasEfd: /EFD[- ]?(?:ICMS|Contribui|Reinf)/i.test(body),
          hasDere: /\bDeRE\b|Declaração de Regimes Específicos/i.test(body),
          hasArquivoDownload: /\/arquivo\/download\/\d+/i.test(body),
          hasItemShow: /\/item\/show\/\d+/i.test(body),
          hasProjetoShow: /\/projeto\/show\/\d+/i.test(body),
          hasPaginaShow: /\/pagina\/show\/\d+/i.test(body),
          bodyHead: body.replace(/\s+/g, ' ').slice(0, 700),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('REQUEST_TIMEOUT')));
    req.on('error', (error: NodeJS.ErrnoException) => {
      resolve({
        scheme,
        path,
        error: error.message,
        code: error.code ?? null,
      });
    });
    req.end();
  });
}

let addresses: Array<{ address: string; family: number }> = [];
try {
  addresses = await lookup(HOST, { all: true });
} catch (error) {
  console.log('SPED_DNS=' + JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
console.log('SPED_DNS=' + JSON.stringify({ addresses }));

for (const address of addresses.filter((entry) => entry.family === 4)) {
  console.log('SPED_TCP=' + JSON.stringify({
    address: address.address,
    http: await tcpProbe(address.address, 80),
    https: await tcpProbe(address.address, 443),
  }));
}

for (const path of paths) {
  const result = await request('http', path);
  console.log('SPED_HTTP_PATH=' + JSON.stringify(result));
}

console.log('SPED_HTTPS_HOME=' + JSON.stringify(await request('https', '/', 10_000)));
console.log('SPED_HTTP_DIAG_DONE=' + JSON.stringify({ generatedAt: new Date().toISOString(), paths: paths.length }));
