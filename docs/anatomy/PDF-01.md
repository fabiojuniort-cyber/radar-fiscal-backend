# ANAT-PDF-01 — leitor de PDF com camada de texto

Governança: tribusca-control#116, entrega 5 da matriz de progresso (comentário 6629944227). Empilhado sobre o ANAT-STRUCT-02 (#281). Lote só com PDFs sintéticos gerados no teste.

## Escolhas técnicas (rotina, sem mudar o contrato)

- **Biblioteca:** `pdfjs-dist` 6.3.289, já declarada no `package.json` (build *legacy*, sem fontes do sistema e sem renderização). Nenhuma dependência nova.
- **Extração:** linha a linha, na ordem de leitura de cada página (de cima para baixo pela linha de base, tolerância de 2 pt; da esquerda para a direita dentro da linha).
  - **O texto não é editado:** não junta hifenização, não reflui parágrafos e não remove cabeçalho nem rodapé.
  - A única normalização é um espaço entre trechos da mesma linha e o corte de espaços no fim da linha.
- **Anatomia:** cada linha vira um bloco do caminho HTML do leitor, com o texto escapado. Assim a gramática estrutural já revisada (agrupamentos, artigos, caput, parágrafos, incisos, alíneas, itens) vale também para PDF.
- **Rastreabilidade:** todo ponteiro de origem vira `representation: 'attachment'`, com `locator: pdf:sha256=<hash do arquivo>;page=<n>;line=<m>` e `sourceSpan: null` (o PDF não tem deslocamento de caracteres). A posição de cada linha no texto canônico fica em `pdf.lines` (`start`/`end`), verificada por correspondência exata.
- **PDF sem camada de texto** (escaneado): nenhum texto é inventado, e a limitação `pdf_without_text_layer` é registrada. OCR está fora deste leitor.
- **Identidade do motor:** `pdf-reader.ts` entra na lista assinada de `build-identity.mjs` (`c00a7dd1…`).

## Testes (`test/anatomy.pdf.unit.test.ts`, 7)

- Ordem de leitura restaurada com linhas desenhadas fora de ordem, sem perda, duplicação, truncamento nem reordenação.
- Estrutura reconhecida: agrupamento, 3 artigos, parágrafo único e incisos.
- Ponteiros com hash, página e linha; o texto de cada linha é igual ao do canônico.
- Acentos e símbolos (º, ª, ç, ã, é, §).
- PDF sem texto.
- Documento extenso: 30 páginas e 1.200 artigos, com ordem e última linha conferidas.
- `&`, `<` e `>` preservados literalmente.

## Limitações declaradas

- **Colunas múltiplas e tabelas em PDF:** a ordem por linha de base mistura colunas lado a lado, e células de tabela viram texto corrido de uma linha. Isso fica para o lote de documentos extensos e anexos (entrega 6), com PDFs oficiais reais.
- **Cabeçalhos e rodapés repetidos por página** continuam no texto, sem marcação. A marcação (`publication_header`/`footer`) depende do layout oficial (entrega 4, rede bloqueada).
- **Homologação com PDFs oficiais** (DOU, DOE-SP): depende da liberação de rede.
