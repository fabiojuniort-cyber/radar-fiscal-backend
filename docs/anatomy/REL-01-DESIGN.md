# ANAT-REL-01 — desenho: relações entre atos e temporalidade (Etapa D)

Governança: tribusca-control#116. **Proposta de desenho para revisão independente. Não há código neste documento.** Estado de partida: o contrato v1 marca contexto (`historical`, `prohibited`, `quoted_text`) e extrai `CITATION`/`LAW_NUMBER`, mas **não modela relação entre atos**, e `legalStatus` é sempre `unknown`.

## 1. Princípios

1. **Fidelidade separada da interpretação.** O texto original e os ponteiros de origem nunca mudam. Relações e datas são uma camada de **asserções** com evidência e procedência.
2. **Toda asserção aponta para o trecho que a sustenta** (`partId` + `span` no ato que dispõe) e para o alvo como foi citado (texto literal), mesmo que o alvo não tenha sido resolvido.
3. **Sem inferência por estilo, cor ou nota editorial.** Uma nota editorial (por exemplo "Redação dada pelo Conv. X") é `editorial_claim`. Só uma disposição do próprio ato modificador é `normative_claim`.
4. **Incerteza explícita.** Cada asserção tem `certainty`:
   - `explicit`: texto dispositivo literal;
   - `derived`: regra documentada, como prazo contado da publicação;
   - `unresolved`: alvo ou data não determinados.
   Uma condição não comprovada (incorporação, ratificação) fica como `condition` aberta, nunca como vigência.
5. **Não altera `legalStatus`** do ato-alvo enquanto não houver resolução revisada. A situação jurídica resultante é uma etapa posterior, com aceite próprio.

## 2. Modelo proposto (contrato v2, aditivo)

```
relation {
  id, kind, certainty, basis: 'normative_claim' | 'editorial_claim',
  sourcePartId, sourceSpan,                 // trecho do ato que dispõe
  target: { citedText, actRef?: {species, number, year, organ}, deviceRef?: {path: ['art 5', '§ 2', 'inciso III']}, resolved: boolean },
  payload?: { newWordingPartId?, quotedSpan?, deadline?, condition? },
  dates?: { publication?, inForce?, effects?, each: {value, certainty, sourceSpan} }
}
kind ∈ amends | amends_partial | repeals | repeals_device | new_wording | adds_device |
       extends_deadline | rectifies | ratifies | conditions_on | cites
```

Correspondência com os casos D1–D8:

| Caso | `kind` | Evidência típica | Incerteza a registrar |
|---|---|---|---|
| D1 ato modifica outro | `amends` | "passa a vigorar com as seguintes alterações" | alvo não resolvido |
| D2 alteração parcial de artigo ou cláusula | `amends_partial` + `deviceRef` | "o inciso III do art. 5º" | dispositivo inexistente no alvo |
| D3 revogação de dispositivo | `repeals_device` | "Fica revogado o § 2º do art. 5º" | revogação tácita **não** é asserção |
| D4 nova redação | `new_wording` + `quotedSpan` | texto entre aspas seguido de "(NR)" | correspondência com a versão anterior |
| D5 prorrogação | `extends_deadline` + `deadline` | "prorrogado até 31/12/2026" | prazo dependente de outro ato |
| D6 retificação | `rectifies` | Onde se lê / Leia-se (hoje `quoted_text`) | republicação × retificação |
| D7 datas distintas | `dates.publication/inForce/effects` | "entra em vigor na data", "produzindo efeitos a partir de" | `derived` quando é cálculo |
| D8 condição não comprovada | `conditions_on` | "após ratificação", "incorporação pela legislação estadual" | sempre `unresolved` até haver prova |

## 3. Preservação de versões

- Cada versão de um documento continua identificada por `documentHash`, como no ANAT-CONFIG-01. Relações referenciam a versão exata.
- Redações anteriores (`historical`) ficam ligadas à nova redação por `new_wording`, sem apagar nenhuma das duas.

## 4. Fora deste desenho

- Consolidação automática de texto vigente.
- Resolução de links por rede.
- Decisão jurídica sobre vigência.
- Reprocessamento do acervo.

## 5. Plano de lotes

1. REL-01a: extrator de asserções **explícitas** (D1, D3, D4, D6 e D7 literal) em sintéticos.
2. REL-01b: `deviceRef` e resolução contra a estrutura do STRUCT-01.
3. REL-01c: prazos e condições (D5 e D8).
4. Homologação com atos oficiais, que depende da rede.

Cada lote passa por revisão independente.

**Decisão pedida ao COORD/revisor:** aprovar o contrato v2 aditivo acima, ou indicar alterações, antes do REL-01a.
