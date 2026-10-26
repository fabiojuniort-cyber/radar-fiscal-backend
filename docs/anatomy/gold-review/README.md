# Pacotes de leitura para a revisão do GOLD-01

Esta pasta existe **só para leitura** pelo revisor independente. As fontes de verdade continuam sendo `test/fixtures/anatomy/gold/<id>.json` e o texto canônico congelado em `test/fixtures/anatomy/canonical/development.json`. A pasta tem uma subpasta por entrada de desenvolvimento (01, 02, 03, 05, 07, 10 e 11); a reserva não está incluída.

Conteúdo de cada subpasta:
- `manifest.json`: `goldContentSha256` (o hash que se aprova), hash do arquivo gold com quebras LF, hash do JSON canônico, hash e comprimento UTF-16 do texto canônico, e a lista dos blocos com seus intervalos e hashes;
- `canonical-NNN.json`: o texto canônico dividido em janelas `[from, to)` em UTF-16, cortadas em quebras de linha. O texto vai como string JSON para que nenhum checkout altere quebras de linha;
- só para 01 e 10: `00-header.json`, `parts-NNN.json`, `entities-NNN.json` e `relations-NNN.json`, com até 250 itens por bloco. As demais entradas são pequenas o bastante para ler o gold inteiro.

**Remontagem:** concatenar os blocos de cada seção em ordem de nome. Um span `[s, e)` do gold corresponde a `texto.slice(s, e)`, sendo `texto` a concatenação dos `canonical-*.text`.

Os pacotes são gerados por `node node_modules/tsx/dist/cli.mjs ops/anatomy/gold-chunks.ts all --write`. O teste `test/anatomy.gold.unit.test.ts` exige que estejam atualizados e que remontem exatamente o gold e o texto canônico.
