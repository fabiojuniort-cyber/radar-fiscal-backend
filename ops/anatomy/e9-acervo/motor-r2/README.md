# E9-MOTOR R2 — evidências do candidato

Base `10e05fd10ea5d1db5e8b6c459e5880d5e861e537`, motor `4b96f97783631b77404493139c2c786554222deda2489e66d3b9c29be981d06a`. Motor candidato `817617b56ffbe347e42131a11fc855a26c304ebb01a669d10fd42339a8514ffe`. A matriz tem 61 células, 29 cobertas, 32 pendentes e zero aceitas no candidato. F1 oficial: 50,2%.

## Lote canônico

[Equivalência amostra a amostra](equivalence.json), SHA-256 nas duas execuções independentes: `3fdcc17ffc35af7ace019f87bc4ddebe809f63a57ed0446617cce52528cd4833`. Foram verificadas 50 entradas pelo [manifesto fixado](inputs.json), com 31 mudanças previstas, 19 equivalências e zero diferenças inesperadas. A comparação registra os digests recalculados e os campos alterados. O [relatório de desempenho](performance.json) contém as duas medições, separadas da prova.

| Frente | Mudanças previstas | Equivalentes | Novas células com leitura completa |
|---|---:|---:|---|
| RFB | 5 | 9 | ADI pequeno (37103), ADE pequeno (148629), Resolução pequeno (122645) |
| DOU | 9 | 3 | 0. M25 saiu do limite de complexidade e segue parcial. |
| CONFAZ | 7 | 3 | 0. M3 saiu do limite de complexidade e segue parcial. |
| Sefaz-SP | 4 | 2 | 0. A leitura continua sujeita à limitação de proveniência. |
| Planalto | 4 | 0 | 0. M10 pequeno (9.391 caracteres) e M12 médio (34.582) têm recorte comprovado e leitura parcial. |
| NORMAS-LEG | 2 | 2 | 0. Versões atualizadas parciais. As originais preservam o diagnóstico. |

## Revalidação proposta

| RFB | Leitura na base | Leitura no candidato | Estrutura |
|---|---|---|---|
| 108391 | Completa | Completa | Equivalente |
| 115131 | Completa | Completa | Equivalente |
| 133898 | Completa | Completa | Equivalente |
| 142967 | Completa | Completa | Equivalente |
| 148693 | Completa | Completa | Equivalente |

Os cinco registros propostos cobrem quatro células. A [proposta append-only](revalidation-proposal.json) referencia as entradas recalculadas nos dois motores. O arquivo oficial conserva os 18 registros e o SHA-256 `905930e58b8d13d988f88e1d912272087d9e8b76c4c3761ca83167246e186ac1`.

## Verificações locais

`build-identity --check`, `tsc --noEmit` e a suíte focada offline (121/121) passaram. A regressão sintética do perfil padrão foi verificada pelo fixture sintético fixado na base.

## Limites

O ADE 148516 ainda depende de anexo externo. A SC 148681 ainda depende do PDF de anexo. O modo de prova usa somente o inventário E9 autorizado. A suíte focada usa fontes explícitas e controles sintéticos. O gate de CI integral depende de Ready autorizado após revisão independente.

## Reprodução

```sh
node ops/anatomy/build-identity.mjs --check
npm run test:anatomy:e9-motor
npx tsx ops/anatomy/e9-acervo/motor-r2/equivalence.mts <checkout-base> . <diretorio-prova-a>
npx tsx ops/anatomy/e9-acervo/motor-r2/equivalence.mts <checkout-base> . <diretorio-prova-b>
```

### Escopo da suíte de draft

A lista explícita roda 11 arquivos e cobre 121 testes: RFB (999/1000, lote, citação), DOU HTML, CONFAZ Plone, Sefaz-SP, Planalto e NORMAS-LEG, além de leitor comum, motor e equivalência sintética dos perfis. O passo de draft também reexecuta a prova canônica nas 50 capturas autorizadas nos dois motores e confere, byte a byte, o relatório determinístico e a proposta dos cinco atos RFB versionados. O checkout de base para a prova materializa os arquivos do manifesto E9, código e configuração de execução. A prova registra o SHA de base `10e05fd1`, mesmo com a evolução independente da main.

O agregado `test:anatomy` tem 29 arquivos adicionais:

- `anatomy.rfb-inline-attachments.unit.test.ts`
- `anatomy.contract.unit.test.ts`
- `anatomy.corpus-integrity.unit.test.ts`
- `anatomy.consumer.unit.test.ts`
- `anatomy.entities.unit.test.ts`
- `anatomy.dou-preparation.unit.test.ts`
- `anatomy.dev-canonical.unit.test.ts`
- `anatomy.gold.unit.test.ts`
- `anatomy.json-preparation.unit.test.ts`
- `anatomy.evaluation.unit.test.ts`
- `anatomy.evaluation-adapter.unit.test.ts`
- `anatomy.profile.unit.test.ts`
- `anatomy.unicode.unit.test.ts`
- `anatomy.unicode-recovery.unit.test.ts`
- `anatomy.rules-simulation.unit.test.ts`
- `anatomy.config.unit.test.ts`
- `anatomy.struct.unit.test.ts`
- `anatomy.struct2.unit.test.ts`
- `anatomy.pdf.unit.test.ts`
- `anatomy.official-provenance.unit.test.ts`
- `anatomy.official-overlap.unit.test.ts`
- `anatomy.official-fetch.unit.test.ts`
- `anatomy.ext.unit.test.ts`
- `anatomy.rfb-anexo.unit.test.ts`
- `anatomy.rfb-parte.unit.test.ts`
- `anatomy.request-budget.unit.test.ts`
- `anatomy.collect-p2c-direct.unit.test.ts`
- `anatomy.collect-p2c-attachment.unit.test.ts`
- `anatomy.corat-annex-route.unit.test.ts`

Ficam para o gate normal, incluindo integridade do corpus, gold/dev/eval, Unicode, extensões e aquisição. Os jobs independentes do GitHub Actions continuam regidos pelos workflows existentes.
