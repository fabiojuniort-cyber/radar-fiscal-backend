# ANAT-L20 — sinal de candidato a retomada de citação RFB (só revisão humana)

Implementação do desenho final do #293 §17, que usa os critérios E0–E7 de §14.1, §15 e §16.

**Base:** COMPOSE-02 (#299 @ `32d66475`, com L21/L22), mais o merge de COLL-TEST-ISO-01 (#301 @ `3f7564e4`). Não herda o L2/L12 (#300); os dois são isolados e serão compostos depois.

## O que muda

- **Classificação: nada muda.** Partes, tipos, contextos, `sourceMap`, cobertura e elegibilidade ficam idênticos. Tudo o que vem depois de uma aspa aberta sem fechamento continua `quoted_text`/`prohibited`. Não há retomada automática.
- **Sinal:** o leitor emite a limitação `rfb_quote_unclosed_resume_candidate` com a evidência. Esse sinal serve só para revisão humana, e o resultado continua `partial`.

## Procedência (E4)

O módulo novo `src/modules/anatomy/rfb-quote-resume.ts` (`planRfbQuoteResume`):
- calcula o plano **a partir do JSON oficial**, reexecutando `prepareRfbRepresentation` sobre os mesmos bytes;
- emite um objeto congelado em profundidade e registrado num `WeakSet` privado, ligado ao SHA do HTML preparado e ao `representationId`.

O leitor (`verifyRfbQuoteResumePlan`) só aceita o plano emitido no mesmo processo, para o mesmo HTML e o mesmo id. Atributos HTML nunca contam como evidência. O motor recusa o plano para qualquer fonte que não seja `RFB`.

A preparação principal RFB (0.2.0, hash `c223c99d` na IN 2.121) **não muda**, e a reconciliação com a captura continua válida.

## Condições (todas obrigatórias; se uma falhar, não há sinal)

| | Condição |
|---|---|
| E0 | A citação abre no 1º bloco de um segmento com `"Art. N` e não fecha no ato. O plano espelha o estado de citação do leitor, que confere de novo que a citação abriu nesse segmento e terminou aberta. O 1º artigo declarado, não tachado e sem aspas depois da abertura é o sucessor de N (N+1, ou N-A/N-B) |
| E1 | O segmento imediatamente anterior à abertura é o artigo N **tachado** |
| E2 | Nenhuma fórmula de alteração ("passa a vigorar", "com as seguintes alterações", "fica acrescido", "nova redação", "com a seguinte redação") **no último artigo operativo nem entre ele e a abertura**. É uma decisão conservadora: a fórmula costuma ficar no caput desse artigo |
| E6 | Todo segmento entre a abertura e o segmento E7 forma pares tachado + vigente de `paragrafo`/`inciso`/`alinea`/`item` com o mesmo rótulo, **com pelo menos um par** |
| E7 | O segmento imediatamente anterior ao sucessor é um agrupamento declarado (`secao`, `subsecao`, `capitulo`, `titulo`, `livro`, `parte`), não tachado e sem aspas, **ou** o próprio sucessor tachado |

Quando não há candidato, o plano registra a condição que falhou (`notCandidate`), só para auditoria. O leitor não emite nada nesse caso.

## Resultado no lote de 7 INs

- **IN 2.121 (127905):** +1 `rfb_quote_unclosed_resume_candidate`. Abertura 4008/706; sucessor 4014/707; E1 4007; E2 [4005, 4006, 4007]; E6 4009/4010 (§ 1º) e 4011/4012 (§ 2º); E7 `secao` 4013.
- **Os outros 6 atos:** só `outputHash`, porque a identidade muda.
- **Não regressão:** o SHA de texto, partes, contextos, `sourceMap`, cobertura e elegibilidade é idêntico com e sem plano nos 7 atos (teste).

**Identidade:** `050602a3` → `0e009431`; o `rfb-quote-resume.ts` entra na identidade. **Local:** `tsc`, ANAT 329/329, `verify-build`, snapshot sintético inalterado, PG16 12/12.

## Contracasos testados (todos `prohibited`, sem sinal)

- §16-1: §§ sem pares e 707 logo em seguida → E7.
- §16-2: agrupamento presente, mas §§ sem pares → E6.
- §16-3: pares presentes, mas sem agrupamento nem par tachado do 707 → E7.
- §15-1: citação introduzida por fórmula de alteração → E2.
- §15-2: sem o 706 tachado antes da abertura → E1.
- §14.1: sucessor que não é N+1 → E0; abertura sem rótulo de artigo → E0.
- Modelo IN 2.021: citação que fecha depois → sem citação aberta.
- E4: plano copiado (JSON, spread, `structuredClone`), de outro HTML, com outro id ou com HTML alterado; atributo `data-rfb-quote-*` no HTML; plano em fonte não RFB (o motor recusa).

## Fora do escopo

Qualquer retomada, mesmo depois de revisão humana, é outra etapa com registro próprio (§17.3).
