import assert from 'node:assert/strict';
import test from 'node:test';

import { actSummaryFromText, publicationDisplayTitle } from '../src/modules/catalog/display-title.js';

test('DOU act stored as one block: the summary after the heading becomes the title', () => {
  const title = 'CONVÊNIO ICMS Nº 113, DE 23 DE SETEMBRO DE 2026';
  const content =
    'CONVÊNIO ICMS Nº 113, DE 23 DE SETEMBRO DE 2026 Dispõe sobre a adesão do Estado de Santa Catarina e altera o Convênio ICMS nº 79, de 3 de julho de 2026. ' +
    'O Conselho Nacional de Política Fazendária - CONFAZ, na sua 431ª Reunião Extraordinária, resolve celebrar o seguinte CONVÊNIO Cláusula primeira O Estado...';
  assert.equal(
    publicationDisplayTitle(title, content),
    'Dispõe sobre a adesão do Estado de Santa Catarina e altera o Convênio ICMS nº 79, de 3 de julho de 2026.',
  );
});

test('DOU act stored in paragraphs (Conv. ICMS 114/26)', () => {
  const content = [
    'CONVÊNIO ICMS Nº 114, DE 30 DE SETEMBRO DE 2026',
    'Autoriza a redução de juros e multas e a remissão parcial do imposto, na forma que especifica.',
    'O Conselho Nacional de Política Fazendária - CONFAZ, na sua 432ª Reunião Extraordinária...',
    'C O N V Ê N I O',
  ].join('\n');
  assert.equal(
    actSummaryFromText('CONVÊNIO ICMS Nº 114, DE 30 DE SETEMBRO DE 2026', content),
    'Autoriza a redução de juros e multas e a remissão parcial do imposto, na forma que especifica.',
  );
});

test('ajustes and protocolos, and headings in another case', () => {
  const content =
    'Ajuste Sinief Nº 12, de 3 de julho de 2026\nAltera o Ajuste SINIEF 7/05, que institui a Nota Fiscal Eletrônica.\nO Conselho Nacional de Política Fazendária - CONFAZ e a Secretaria Especial...';
  assert.equal(
    actSummaryFromText('AJUSTE SINIEF Nº 12, DE 3 DE JULHO DE 2026', content),
    'Altera o Ajuste SINIEF 7/05, que institui a Nota Fiscal Eletrônica.',
  );
});

test('keeps the stored title when it is already a summary or the text does not help', () => {
  const ementa = 'Reduz a base de cálculo do ICMS nas saídas dos insumos agropecuários que especifica, e dá outras providências.';
  assert.equal(publicationDisplayTitle(ementa, 'qualquer texto'), ementa);
  const heading = 'CONVÊNIO ICMS Nº 9, DE 1º DE ABRIL DE 2026';
  assert.equal(publicationDisplayTitle(heading, null), heading);
  assert.equal(publicationDisplayTitle(heading, 'Outro ato qualquer sem o cabeçalho. O Conselho Nacional...'), heading);
  // Publication notes right after the heading are not a summary.
  assert.equal(
    publicationDisplayTitle(heading, `${heading}\nPublicado no DOU de 02.04.26.\nO Conselho Nacional...`),
    heading,
  );
  // No preamble found: nothing is guessed.
  assert.equal(publicationDisplayTitle(heading, `${heading}\nTexto sem preâmbulo.`), heading);
});
