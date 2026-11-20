# E9-MOTOR R2 — auditoria de IDs duplicados de entidades

Aferição offline do candidato `0f584f2128b763022622573e714b54ef7d03790b`, motor `817617b56ffbe347e42131a11fc855a26c304ebb01a669d10fd42339a8514ffe`, em atendimento à [decisão da #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-7024380349).

A instrumentação local capturou a condição exata de `engine.ts` após a extração das entidades e comparou o status anterior ao descarte com o status validado pelo contrato. A verificação usou o lote RFB reproduzível, a projeção do acervo oficial e as preparações DOU XML e CONFAZ HTML dos 12 atos congelados disponíveis. As 14 entradas brutas do corpus conferiram com tamanho e SHA-256 do manifesto.

| Fonte da entrada | Perfil efetivo | Acervo/lote E9 | Corpus congelado | Ocorrências | Mudanças de status |
| --- | --- | ---: | ---: | ---: | ---: |
| RFB | Padrão | 14 | 0 | 0 | 0 |
| DOU | DOU | 10 | 10 | 0 | 0 |
| CONFAZ | CONFAZ | 10 | 2 | 1 | 0 |
| Sefaz-SP | Padrão, com preparação de portal | 6 | 0 | 0 | 0 |
| Planalto | Padrão, com preparação de ato | 4 | 0 | 0 | 0 |
| normas.leg.br | Padrão, com preparação de versão atualizada | 2 | 0 | 0 | 0 |
| normas.leg.br | DOU, diagnóstico de versões originais | 2 | 0 | 0 | 0 |
| **Total** | | **48** | **12** | **1** | **0** |

Perfis efetivos SHA-256: padrão `e400afdf089ee7912f383231f3566bd4db2674315e6a0a757f6d204d405c696`, DOU `5869876f358d138d979ab642613886e4f875e7914353d05cf033313644d23956` e CONFAZ `9714010982b6c47afd4a27f9746d032d691213da4198c5cb2eee1b8665d319b0`.

O único disparo no material oficial ocorreu em `http:M3` (CONFAZ). Sete entradas repetiam IDs, as entidades foram descartadas e a leitura permaneceu `partial`. A regra conserva o escopo do parecer. A identidade do motor corresponde à da prova canônica de 50 amostras.

As duas páginas DOU em PDF do inventário E9 são evidências de cabeçalho e rodapé. Na projeção, ambas têm `read: false`, portanto ficaram fora das 48 chamadas do motor. O corpus documenta 18 atos sem corpo original disponível. A aferição mede apenas status de leitura e descarte de entidades.

Como controle adicional, o agregado instrumentado passou pelo motor 908 vezes em 228 combinações distintas de fonte, perfil, família e entrada. O disparo repetido em testes correspondeu ao mesmo `http:M3`. As oito chamadas do controle DOE-SP ficaram sem disparos. O agregado local no Windows registrou 430/432 testes aprovados. As duas falhas ocorreram em um controle de transporte loopback e em uma abertura de fixture com o volume `C:` duplicado no caminho. O resultado do CI padrão no Linux é a evidência do gate integral.
