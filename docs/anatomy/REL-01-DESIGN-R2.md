# ANAT-REL-01 — desenho revisado (R2): relações entre atos e temporalidade

Governança: tribusca-control#116. A R2 incorpora os ajustes da decisão 8 do comentário 6542971547 e substitui a v1 (`REL-01-DESIGN.md`, no #280). **Proposta para revisão independente. Não há código.** O contrato v2 **não está aprovado**.

## 1. Garantias invariantes

1. **O original é imutável.** Texto canônico, spans, ponteiros de origem e hashes de apresentação do documento nunca mudam por causa de uma relação.
2. **Camada separada e aditiva.** Relações e eventos temporais ficam fora de `parts` e `entities`. Uma análise sem relações é idêntica à de hoje.
3. **Idempotência.** Mesmo documento (`documentHash`), mesmas regras (`ruleSetHash`) e mesmo motor (`engineHash`) produzem as mesmas relações, com ids determinísticos derivados de origem, span e tipo.
4. **Estado jurídico independente.** Nenhuma relação altera `legalStatus`, que continua `unknown` enquanto faltar prova e resolução revisada. A conclusão jurídica fica numa etapa posterior, com aceite próprio.
5. **Sem inferência por estilo.** Cor, classe CSS, tachado ou nota editorial **nunca** sustentam sozinhos uma relação normativa.

## 2. Três eixos independentes por asserção

| Eixo | Valores | Pergunta que responde |
|---|---|---|
| `evidenceBasis` | `normative` (disposição do próprio ato) · `editorial` (nota do portal ou compilação, como "Redação dada por…") | **De onde** vem a afirmação? |
| `extraction` | `explicit` (literal no texto) · `derived` (regra documentada, como prazo contado da publicação) | **Como** foi obtida? |
| `resolution` | `unresolved` (alvo não localizado) · `ambiguous` (mais de um candidato, todos listados) · `resolved` (um alvo exato, versão e dispositivo) | O alvo **foi identificado**? |

Os eixos não se combinam num único "grau de certeza". Uma asserção `editorial + explicit + resolved` continua editorial.

## 3. Identidades

```
ActRef {                       // ato de origem ou de destino
  jurisdiction: 'federal' | 'estadual:<UF>' | 'municipal:<IBGE>' | 'interestadual',
  organ: string,               // ex.: CONFAZ, RFB, SEFAZ-SP
  species: string, number: string, year: number,
  source: { portal: 'CONFAZ'|'DOU'|'DOE-SP'|'RFB'|…, url?: string }
}
VersionRef { act: ActRef, documentId?: string, documentHash?: sha256, consultedAt?: date }   // versão exata
DeviceRef  { version: VersionRef, path: string[] /* ['art. 5', '§ 2º', 'inciso III'] */, partId?: string }
```

- **Origem:** sempre resolvida. É o próprio documento analisado (`documentHash` + `partId` + `span`).
- **Destino:** o texto citado literal fica sempre preservado (`citedText`). `ActRef`, `VersionRef` e `DeviceRef` só são preenchidos quando a resolução alcança esse nível; nada é completado por suposição.
- **R2.2, identidade exata obrigatória para `resolution: 'resolved'`:** o alvo resolvido **precisa** ter `VersionRef.documentHash` (versão exata analisada no acervo), `DeviceRef.path` e `DeviceRef.partId`, e a parte precisa existir naquela versão. Sem esses três campos, a validação rebaixa a relação para `ambiguous` ou `unresolved`, nunca a aceita como `resolved`. A resolução contra "o ato em geral" sem versão é sempre `unresolved`.

## 4. Relação

```
Relation {
  id,                                    // determinístico
  kind: amends | amends_partial | repeals | repeals_device | new_wording | adds_device |
        extends_deadline | rectifies | ratifies | conditions_on | cites,
  evidenceBasis, extraction, resolution,
  origin: { documentHash, partId, span },
  target: { citedText, candidates: DeviceRef[] /* 0 = unresolved, >1 = ambiguous */ },
  payload?: { newWordingSpan?, previousWordingPartId?, quotedSpan?, deadline?: TemporalEvent },
  events: TemporalEvent[]                // datas que esta relação estabelece ou altera
}
```

## 5. Temporalidade por dispositivo e por evento

```
TemporalEvent {
  id: string,                  // R2.1: identidade própria, determinística:
                               // sha256(origin.documentHash | origin.partId | originSpan | kind | appliesTo-canônico)
  provenance: {                // R2.1: procedência versionada obrigatória
    documentHash, partId, span,                     // trecho que estabelece o evento
    engineHash, ruleSetHash, extractedAt            // versão exata do motor e das regras que o extraíram
  },
  kind: 'publication' | 'in_force' | 'effects' | 'deadline' | 'ratification' | 'incorporation',
  appliesTo: DeviceRef | 'whole_act',
  value?: date, rule?: 'on_publication' | 'first_day_next_month' | 'days_after:<n>' | …,
  extraction, evidenceBasis, originSpan,
  condition?: { text, status: 'open' | 'met' | 'unproven' },   // ex.: ratificação, incorporação estadual
  supersedes?: TemporalEvent['id'],                            // cadeia: prorrogação sobre prorrogação
  dependsOn?: TemporalEvent['id'][]                             // ex.: efeitos dependem da ratificação
}
```

### 5.1 Validade das cadeias (R2.4)

O contrato de validação recusa, sem gravar nada:
- **ciclos** em `supersedes` ou `dependsOn`, verificados por busca em profundidade sobre o grafo de eventos;
- `supersedes` entre eventos de `kind` diferentes, ou com `appliesTo` incompatível (a prorrogação de um prazo do art. 5º não substitui o vigor do art. 6º);
- `supersedes` apontando para um evento de origem **posterior** ao do evento que substitui, comparando a data de publicação da versão de origem;
- mais de um sucessor para o mesmo evento vindo da mesma versão de origem: é ambiguidade, e o evento fica `resolution: 'ambiguous'`, sem escolha automática;
- referência a um id inexistente.

- Publicação, vigor e efeitos são **eventos distintos**, mesmo quando caem na mesma data.
- Um prazo derivado (`rule`) guarda a regra e o span. A data calculada é marcada `derived`.
- **Cadeia temporal:** cada prorrogação aponta, por `supersedes`, para o evento que prorroga. A cadeia é exibida inteira, nunca colapsada no último valor.
- Uma condição não comprovada (`unproven`, `open`) **impede** que o evento sustente vigência.

## 6. Casos D1–D8

| Caso | Representação | Incerteza registrada |
|---|---|---|
| D1 ato altera outro | `amends`, destino ao nível de `ActRef` | `unresolved` se o ato não estiver no acervo |
| D2 alteração parcial | `amends_partial` com `DeviceRef.path` | `ambiguous` se o caminho casar com mais de um dispositivo |
| D3 revogação de dispositivo | `repeals_device` | revogação tácita **não** é extraída |
| D4 nova redação | `new_wording` + `newWordingSpan` + `previousWordingPartId` | ligação com a versão anterior só se `resolved` |
| D5 prorrogação | `extends_deadline` + evento `deadline` com `supersedes` | prazo condicionado → `condition.open` |
| D6 retificação | `rectifies` (Onde se lê / Leia-se); o original e o corrigido continuam `quoted_text` | republicação × retificação ficam distintas |
| D7 datas distintas | três `TemporalEvent` separados | `derived` quando há cálculo |
| D8 condição não comprovada | `conditions_on` + `condition.status = 'unproven'` | nunca promovida a vigência |

## 6.1 Situação jurídica independente (R2.5)

```
LegalState {                         // camada própria; nunca escrita por extração
  subject: DeviceRef,                // dispositivo de uma versão exata
  asOf: date,
  value: 'unknown' | 'current' | 'repealed' | 'replaced' | 'future' | 'suspended',
  basis: { relationIds: string[], eventIds: string[] },   // asserções que sustentam a conclusão
  decidedBy: 'rule' | 'reviewer',
  review?: { reviewer, at, note }    // obrigatório quando value ≠ 'unknown'
}
```

- **Valor padrão:** `unknown`. Relações e eventos **nunca** alteram `LegalState` por si sós. `parts[].legalStatus` do contrato v1 continua `unknown`.
- **Transição:** sai de `unknown` só por uma etapa de decisão separada, com aceite próprio, que exige:
  - `basis` não vazia;
  - todas as relações citadas com `evidenceBasis: 'normative'` e `resolution: 'resolved'`;
  - todos os eventos sem condição aberta;
  - revisão registrada.
- **Prova insuficiente:** se qualquer requisito faltar, o valor permanece `unknown`, com a lista do que falta. Ausência de evidência nunca vira `repealed` nem `current`.

## 7. Persistência (quando houver código)

- Tabelas novas, só de inserção: relações e eventos por análise. As análises existentes não mudam, e nada é reprocessado.
- Mesma RLS e auditoria do ANAT-CONFIG-01. Nenhuma migration é proposta antes da aprovação deste desenho.

## 8. Lotes depois da aprovação

1. **REL-01a:** relações `normative + explicit` em sintéticos (D1, D3, D4, D6, D7 literais), sem resolução de destino (`unresolved`).
2. **REL-01b:** `DeviceRef` contra a estrutura do STRUCT-01 e STRUCT-02, e resolução `resolved`/`ambiguous` dentro do mesmo documento.
3. **REL-01c:** eventos `derived`, cadeias (`supersedes`) e condições (D5, D8).
4. Homologação com atos oficiais (depende da rede), seguida de revisão independente.

## 9. Pontos pedidos à revisão

- Os três eixos são suficientes, ou falta um nível de "revisado por humano" (`reviewed`)?
- `jurisdiction` × `organ`: o portal (`source.portal`) basta para a procedência, ou cada relação deve guardar a URL do destino quando houver resolução?
- Limite de candidatos em `ambiguous` (proposta: até 10, com contagem total).
