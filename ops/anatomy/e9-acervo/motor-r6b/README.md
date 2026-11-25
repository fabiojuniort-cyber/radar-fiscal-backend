# E9 R6b — corroboração manual SEFAZ-SP

Base 5bbe350b. As seis capturas manuais são do commit 7c5271a5efb0b953bf10cd9b47effe86ebc83bd8. O MANIFEST registra a URL canônica, o hash, o tamanho e o horário limite de recepção, 2026-11-25T02:22:26Z. O instante exato de salvamento permanece desconhecido.

Foram verificados SHA-256 e tamanho de cada arquivo manual e arquivado. A URL canônica no HTML manual, a do MANIFEST e as URLs de origem e final arquivadas identificam a mesma página oficial em cada par. A região do ato tem HTML idêntico byte a byte e o motor produziu texto canônico idêntico, sem normalização. A comparação adicional de texto fora da região, excluindo scripts, estilos, noscript e templates e normalizando espaços, também coincidiu. Os arquivos completos diferem em HTML externo à região do ato.

| Captura | Bytes arquivado → manual | Caracteres canônicos | Diferenças de texto do ato |
| --- | ---: | ---: | --- |
| ricms-art008 | 156994 → 155425 | 3219 | 0 |
| ricms-art009 | 154921 → 153352 | 3340 | 0 |
| ricms-an2art039 | 168294 → 166725 | 12616 | 0 |
| ricms-an2art003 | 176447 → 174894 | 20457 | 0 |
| ricms-an1art041 | 199138 → 197569 | 33383 | 0 |
| ricms-art007 | 165355 → 163786 | 11628 | 0 |

Cada meta arquivada registra o commit e os digests da corroboração. Os HTMLs arquivados continuam idênticos à base. A matriz offline só resolve a pendência de proveniência após recalcular o hash do HTML manual, conferir o MANIFEST, a URL no HTML e a igualdade da região. Qualquer outra limitação substantiva continua bloqueando a completude. O motor e o output original preservam suas identidades, seus contextos e o limite da preparação local genérica.

As duas células ficam aceitas no ledger offline por quatro amostras-alvo. As amostras art. 7º e Anexo I art. 41 seguem como contraprovas, ambas completas na matriz e sem aceite individual. Os 122 registros anteriores foram preservados, e a matriz candidata fica em 26/61. A REV independente deve reexecutar a prova.

```sh
node --import tsx ops/anatomy/e9-acervo/motor-r6b/equivalence.mts <base-5bbe350b> <candidato> <diretório-existente>
```

Os relatórios equivalence.json e acceptance-proof.json são determinísticos. performance.json registra medição local e fica fora da comparação de digests.
