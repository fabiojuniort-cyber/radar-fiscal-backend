# E9-MOTOR R6

Base canônica c4f2105cea769a3cd5736bf13bdda29a83792e70, motor 87337b64. As capturas e os metadados têm os mesmos bytes da base.

| Ordem | Célula | Evidência |
| --- | --- | --- |
| 1 | RFB · Instrução Normativa · médio | rfb:141910. A leitura estritamente offline identifica os 28 incisos do tipo 999 que estavam pendentes (3.640 caracteres), com sequência romana corroborada e histórico dos tachados preservado. |
| 2 | SEFAZ-SP · RICMS artigo · pequeno | ricms-art008 e ricms-art009. Cabeçalho de página proibido para seleção e separadores estruturais reconhecidos. Candidata, com gate de proveniência. |
| 3 | SEFAZ-SP · RICMS artigo · médio | ricms-an2art039 e ricms-an2art003, com ricms-an1art041 e ricms-art007 como contraprovas. Candidata, com o mesmo gate. |

A regra RFB exige um dispositivo aberto, um ordinal romano válido e a confirmação da sequência. Alíneas e itens reconhecidos na fonte não interrompem a busca pelo inciso par. Um início exige a fórmula introdutória e o inciso II. O reconhecimento de um tachado exige uma introdução comprovada com o inciso anterior ou uma redação substitutiva de mesmo ordinal. O contexto de um inciso tachado fica histórico. A regra do título SEFAZ-SP exige o perfil tipado, a preparação emitida para o HTML exato, o elemento título diretamente na região preparada e um cabeçalho hierárquico. O próprio conteúdo continua no texto canônico, com os ponteiros preservados. Espaços em branco sem dono são estruturais. U+200B só recebe esse tratamento no prefixo da região.

## Proveniência SEFAZ-SP

Em todos os seis metadados, a URL de coleta e a URL final usam o host oficial, o estado HTTP é 200, a data de coleta existe, e o SHA-256 e o número de bytes conferem com a captura. A trilha comprova a integridade dos arquivos arquivados. O acervo mantém os metadados como candidatos, com urlVerified e verified falsos, e o motor conserva sefaz_sp_portal_local_preparation_only. O R6 não altera esses campos, o gate nem o ledger para SEFAZ-SP.

Páginas para confirmação do Fábio. Na página oficial já carregada, salvar com Ctrl+S como **Página da Web, somente HTML**, com os nomes abaixo. Registrar a URL final e a data/hora com fuso. Preservar os bytes salvos, inclusive o encoding, para que o hash e o tamanho sejam calculados na ingestão. As quatro primeiras são as amostras-alvo. As duas últimas servem de contraprova.

| Arquivo | URL |
| --- | --- |
| ricms-art008.html | https://legislacao.fazenda.sp.gov.br/Paginas/art008.aspx |
| ricms-art009.html | https://legislacao.fazenda.sp.gov.br/Paginas/art009.aspx |
| ricms-an2art039.html | https://legislacao.fazenda.sp.gov.br/Paginas/an2art039.aspx |
| ricms-an2art003.html | https://legislacao.fazenda.sp.gov.br/Paginas/an2art003.aspx |
| ricms-an1art041.html | https://legislacao.fazenda.sp.gov.br/Paginas/an1art041.aspx |
| ricms-art007.html | https://legislacao.fazenda.sp.gov.br/Paginas/art007.aspx |

## Prova

Em cópias graváveis e isoladas da base canônica e do candidato, com as dependências instaladas:

```sh
npm run anatomy:verify-build
npm run test:anatomy:e9-motor
node --import tsx ops/anatomy/e9-acervo/motor-r6/equivalence.mts <base> . <diretório-existente>
```

A prova verifica bytes, ponteiros, citações, legalStatus e o invariante de ancestralidade em 48 leituras de 50 capturas. M9 não tem saída de leitura. M25 e o P3-a de M12 ficam fora do escopo de mudança. O candidato preserva os 95 registros históricos e revalida 26 amostras das 23 células previamente aceitas.
