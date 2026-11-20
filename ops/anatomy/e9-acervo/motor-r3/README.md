# E9-MOTOR R3 — separadores estruturais e corpo HTML aninhado

Base `03831fd3ae9f19e90aa0be1a44660036c4aab723` · motor `817617b56ffbe347e42131a11fc855a26c304ebb01a669d10fd42339a8514ffe`. Motor R3 `7b7260b22ff8ba73d15277c8d5a7919bd277f913f347e7194648fab4c132cb23`. [Diagnóstico E9-A4](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-7045465751)

## Escopo e resultado

- Sob preparação oficial vinculada à representação DOU ou CONFAZ, espaços e separadores descobertos entram na cobertura estrutural do documento. Blocos exclusivamente brancos deixam de gerar partes desconhecidas. Texto, spans e mapa de origem permanecem intactos, inclusive onde há caracteres reais ou U+200B.
- O DOU percorre o HTML interno quando a preparação comprova a região do ato e o contêiner tem um único corpo HTML. O leitor trabalha sobre o mesmo HTML, com os mesmos limites. Invólucros com imagens seguem no caminho anterior, incluindo M25. As regras de citação e `legalStatus: unknown` continuam em vigor.
- 50 amostras conferidas por tamanho e SHA-256. A prova compara ambos os lotes recalculados, os baselines e as projeções, com digests de saída por amostra. A lista de alterações esperadas está no [manifesto](inputs.json). As medições ficam no [relatório separado](performance.json).

| Fonte e célula | Leitura no R3 | Amostra e razão |
| --- | --- | --- |
| CONFAZ · Convênio ICMS pequeno | Completa | M14 e M16 · separadores |
| CONFAZ · Convênio ICMS grande | Parcial | M3 e M4 · títulos e apêndices, e falha de entidades em M3 |
| CONFAZ · Ajuste SINIEF pequeno | Completa | M18 · separadores |
| CONFAZ · Ajuste SINIEF grande | Completa | M19 · separadores e vazios. M5 manual e HTTP seguem parciais |
| CONFAZ · Protocolo ICMS pequeno | Completa | M20 · separadores. M21 segue parcial |
| DOU · IN pequena | Completa | M23 · separador |
| DOU · IN média | Completa | M24 · corpo interno e separadores |
| DOU · IN grande | Parcial | M25 · preservada, fora do ciclo |
| DOU · Decreto pequeno | Parcial | M26 · assinatura e título de anexo |
| DOU · Decreto grande | Completa | M28 · parágrafos vazios e separador |
| DOU · Portaria pequena | Completa | M29 · corpo interno e separadores |
| DOU · Portaria média | Completa | M30 · corpo interno e separadores |
| DOU · Resolução pequena | Completa | M32 e M33 · corpo interno e separadores |
| DOU · Resolução grande | Parcial | M34 · epígrafe e cabeçalho do órgão |

A matriz candidata tem 29/61 cobertas, 32 pendentes, dez novas células com leitura completa e zero aceites vinculados ao motor R3. Os 26 registros históricos permanecem byte a byte. As oito amostras dos sete aceites no R2 continuam completas e semanticamente equivalentes. A [proposta append-only](revalidation-proposal.json) inclui a referência e os digests anterior e recalculado para cada amostra.

## Reprodução

Use checkouts isolados com finais de linha do Git (`core.autocrlf=false`), dependências do lockfile e dois diretórios de saída vazios. O verificador usa os mesmos parâmetros e pontos de entrada da matriz e do lote e remove as sondas temporárias ao terminar.

```sh
npm run anatomy:verify-build
npm run test:anatomy:e9-motor
node --import tsx ops/anatomy/e9-acervo/motor-r3/equivalence.mts <base> . <prova-a>
node --import tsx ops/anatomy/e9-acervo/motor-r3/equivalence.mts <base> . <prova-b>
```

A [prova canônica](equivalence.json) registra os campos comparados e os resultados por célula. As diferenças de identidade do motor são contabilizadas à parte do conteúdo e da estrutura. A suíte focada inclui contracasos para prova ausente, texto desconhecido real, U+200B, imagem no invólucro, outra fonte, citação em bloco e tabela citada.
