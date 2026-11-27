# E9 R7

Base `1d7eb224`, motor `a18cd9b1`. Trabalho offline com os bytes e metadados já arquivados.

| Célula | Resultado da reavaliação |
| --- | --- |
| RFB · ADE médio | Parcial. O corpo de `148516` tem 51 segmentos, 0 caracteres não identificados e 0 binários. Os arts. 1º e 17 exigem o Anexo Único, ausente no JSON arquivado. |
| normas.leg.br · Lei grande | Parcial. As Leis 10.637 e 10.833 têm 1.200 e 908 caracteres não identificados e 30 e 3 blocos de compilação ambíguos, respectivamente. Ambas têm imagem sem leitura e proveniência local pendente. |
| RFB · IN grande | Aceita por `115131`. `127905`, `104314` e `116968` continuam parciais, com 14, 1.819 e 103 caracteres não identificados e 30, 30 e 35 anexos sem conteúdo, respectivamente. A versão multivigente inclui 1, 30 e 20 desses anexos marcados como tachados, na mesma ordem. |
| Planalto · Lei grande | Aceita por `http:M1`. `http:M2` continua parcial, com 5.662 caracteres em itens numerados, tabela TIPI aninhada e resíduos editoriais. |
| CONFAZ · Convênio ICMS grande | Aceita por `http:M4`. `http:M3` deixa de ter texto não identificado e continua parcial: ocorrências distintas de `exceto` cobrem a mesma linha de tabela, geram IDs de exceção iguais e bloqueiam a extração de entidades. |
| CONFAZ · Ajuste SINIEF grande | Aceita. `M5` e `http:M5` passam à leitura completa com 0 caracteres não identificados, mediante prova da epígrafe legada (zero inicial no número). |
| CONFAZ · Protocolo ICMS pequeno | Aceita. `M21` passa à leitura completa com 0 caracteres não identificados, mediante prova da epígrafe legada (dia ordinal). |

Os números da tabela usam as notas da matriz, que somam spans das partes. `equivalence.json` mede os segmentos exclusivos de cobertura. Para `http:M2` são 5.806 caracteres na medida exclusiva. Nas duas leis de normas.leg.br, são 1.202 e 866, respectivamente.

O caminho legado do CONFAZ exige que a epígrafe seja o primeiro bloco visível e o único título explícito em toda a região. A prova de unicidade conta as classes antiga e moderna, inclusive em elementos aninhados. Para M21, M5 e `http:M5`, a REV comparou o recorte com a epígrafe literal na base e obteve os mesmos offsets, hash da região e texto canônico.

M12 mantém leitura completa. A mudança se limita aos 17 marcadores autônomos de revogação em incisos e parágrafos com sufixo editorial, incluindo `(Redação dada ...)` e `Produção de efeitos`. O texto canônico, os spans, a origem e o estado jurídico desconhecido permanecem preservados. As contraprovas cobrem dispositivos com texto substantivo junto de referência à revogação.

Os 126 registros existentes são preservados. As 31 revalidações reproduzem as 26 células já aceitas e padronizam os limites no padrão E9-A1: escopo offline, evidência limitada à amostra/layout/porte, `legalStatus: unknown`, identidade do motor e condição para merge/produção. Os três resultados CONFAZ que saíram da leitura parcial continuam evidências complementares às amostras originalmente aceitas.

## Reexecução

Em checkouts separados da base e do candidato, com dependências instaladas, criar dois diretórios de saída distintos. Executar a partir do candidato:

```sh
npm run anatomy:verify-build
npm run typecheck
npm run test:anatomy
node --import tsx ops/anatomy/e9-acervo/motor-r7/equivalence.mts <base> . <saída-a>
node --import tsx ops/anatomy/e9-acervo/motor-r7/equivalence.mts <base> . <saída-b>
```

Conferir os SHA-256 de `equivalence.json` e `revalidation-proof.json` nas duas saídas e no histórico versionado. `performance.json` registra a medição da primeira execução e fica fora do confronto de digests. O verificador compara a identidade neutralizada das leituras, preserva o ledger anterior como prefixo, recalcula cada entrada e verifica toda a cadeia de ancestrais das partes operativas.

A prova registra 45 capturas equivalentes, 5 mudanças previstas (`M12`, `M21`, `M5`, `http:M5` e `http:M3`) e zero inesperadas. A ancestralidade foi verificada em 48 leituras de cada motor, com zero violações. Duas capturas PDF M9 foram verificadas no inventário e seguem sem leitura do motor.

A cobertura da matriz continua em 29/61, com 26 células aceitas. O PR fica draft para a REV independente. Qualquer mudança de HEAD após a REV exige OK da COORD antes do merge.

[Lista consolidada de downloads](downloads.md) · [Planos de M25 e M9](m25-m9-plan.md)
