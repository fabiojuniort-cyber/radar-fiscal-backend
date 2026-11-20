# E9-A3 — leituras parciais RFB já cobertas (proposta; nada registrado)

Mandato: COORD → EXEC F1 "E9-A3" (tribusca-control#116). Base: main `d53fb3e2`, motor `4b96f977…`.
Escopo: offline, acervo versionado. Nenhuma alteração em `src/`, na matriz ou em `docs/anatomy/e9-acceptances.json`.

| Arquivo | Conteúdo |
|---|---|
| `e9a3-partial-rfb-proof.mts` | prova reprodutível: mesma requisição do lote (`analyzeLot`) + `rfbReadingAssessment` + varredura do acervo |
| `e9a3-partial-rfb-proof.json` | evidência por célula e amostra; duas execuções byte-idênticas |
| `e9a3-proposed-acceptances.json` | 0 registros: nenhuma amostra APTA |

## Reprodução e procedência

As 5 amostras passaram nas 8 conferências:
- bytes = meta = lote;
- entrada do lote recalculada = armazenada, portanto `entrySha256` recalculado = armazenado;
- `outputHash` e HTML preparado iguais ao lote;
- `legalStatus` unknown;
- célula derivada = célula do mandato;
- motor do lote = motor atual.

## Outra amostra no acervo (item 2)

Varredura: as 3 pastas RFB que o lote e a matriz leem (`rfb-normasinternet2`, `rfb-normasinternet2-coleta02`, `rfb-p2c`), 14 amostras.
Nenhuma outra amostra cai nestas 5 células. Fora delas não há JSON RFB preservado:
- os itens RFB do corpus de teste não têm `inputs`;
- os candidatos de `candidates-b-rfb-2026-11-10.csv` nunca foram coletados.

## Classificação (rigor E9-A1)

| Célula | Amostra | Classe | Motivo exato (`rfbReadingAssessment` + fonte) | Rota |
|---|---|---|---|---|
| IN médio | rfb:141910 (IN RFB 2237/2024) | **PARCIAL** | 11.279 chars não identificados. 85 segmentos com `idTipoSegmento` 999 ("não identificado pela fonte") são **incisos dispositivos** sem separador após o romano ("I que ocorrerem…", "I as pessoas jurídicas…"). Mais `rfb_tachado_evidence` ×4. | Motor (E9-M2/M3) |
| ADI pequeno | rfb:37103 (ADI RFB 18/2011) | **PARCIAL** | 31 chars: a assinatura "CARLOS ALBERTO FREITAS BARRETO" vem com `idTipoSegmento` 1000, não mapeado (`rfb_segment_type_unmapped`). | Motor (E9-M2/M3) |
| ADE pequeno | rfb:148629 (ADE Cofis 30/2025) | **PARCIAL** | 415 chars: o **preâmbulo** ("A COORDENADORA-GERAL DE FISCALIZAÇÃO, no uso da atribuição…") vem como tipo 999. O anexo HTML inline já é lido (26/26). | Motor (E9-M2/M3) |
| ADE médio | rfb:148516 (ADE Corat 33/2025) | **PARCIAL** | 262 chars: preâmbulo ("O COORDENADOR-GERAL…") e "DECLARA:" vêm como tipo 999. **Anexo Único próprio ausente da representação** (anexo externo). | Motor (E9-M2/M3) + coleta do anexo (P2-c, grants suspensos) |
| Resolução pequeno | rfb:122645 (Res. CGSN 164/2022) | **PARCIAL** | 272 chars: preâmbulo ("O Comitê Gestor do Simples Nacional, no uso das atribuições…") vem como tipo 999. | Motor (E9-M2/M3) |

**Resultado:** 0 APTAS, 5 PARCIAIS, 0 BLOQUEADAS. Nenhuma célula tem amostra apta.

## Rotas para as não aptas

- **Motor (E9-M2/M3, muda a identidade):** classificar segmentos que a fonte marca como 999 pelo conteúdo, sem inventar contexto:
  - inciso romano sem separador;
  - fórmula de preâmbulo ("no uso da atribuição/das atribuições");
  - "DECLARA:" / "RESOLVE:".
  
  E mapear o `idTipoSegmento` 1000 (assinatura). Resolve 141910, 37103, 148629 e 122645. Em 148516, resolve só a parte textual.
- **Coleta:**
  - Anexo Único do ADE Corat 33/2025, que exige a rota P2-c (grants suspensos).
  - Opcionalmente, novas amostras dos mesmos tipos e portes, se o COORD preferir amostra a mudança de motor.
- **Ferramenta (E9-M1):** não é necessária para estas células. O avaliador RFB já existe e acusa as lacunas corretamente.

## Reproduzir

```bash
git worktree add --detach /var/tmp/e9a3 d53fb3e2b8d34b9fbeda4da6c5fbdf25a24c19e9
ln -s "$PWD/node_modules" /var/tmp/e9a3/node_modules
cd /var/tmp/e9a3 && npx tsx <este-dir>/e9a3-partial-rfb-proof.mts . out.json && sha256sum out.json
# esperado 180348af07a7e22226cab6bd50a45ad6d5cd03defefbcbd69545b75f2d45ccea (duas execuções idênticas)
```
