# L-LEG-01 — normas.leg.br (versão atualizada): notas de redação, revogação e "vide" — só desenho

Autorizado pelo COORD (#116 c.6701950134 §6): diagnóstico, desenho de preparação/leitura e contracasos offline. **Não altera a classificação do motor.** A implementação depende de decisão.

## 1. Fatos (bytes de `official-identification/leg-normas/*-atualizada.html`)

| | Lei 10.637/2002 | Lei 10.833/2003 |
|---|---|---|
| Âncoras `<a>` no corpo | 180 | 470 |
| Host das âncoras de nota | `www2.camara.leg.br` (166), `www2.camara.gov.br` (9) | `www2.camara.leg.br` (452), `www2.camara.gov.br` (18) |
| Notas "(Redação dada / com nova redação / acrescido / incluído …)" | dezenas, no fim do bloco do dispositivo | idem |
| Notas "(Revogado/Revogada pela …)" | 15 | 33 |
| Notas "(Vide …)" | 14 | 35 |
| Dispositivos que têm **só** rótulo + nota de revogação (sem texto) | 6–7 | 14 |
| Texto tachado / redação anterior preservada | **nenhum** (sem `<strike>`/`<del>`/`line-through`) | **nenhum** |

**Marcação:** a nota é um `<a href="…camara…/legin/…">` com `<span class="Hyperlink" style="font-style:italic">(…)</span>`, dentro do mesmo `<p>` do dispositivo, depois do texto. Exemplo (10.637, art. 1º): `Art. 1º A Contribuição … contábil. (“Caput” do artigo com redação dada pela Medida Provisória nº 627 …)`.

**Consequência:** a versão atualizada **não traz redação anterior**. "Redação dada pela…" informa que o texto mostrado é o vigente segundo a compilação, mas não oferece um texto antigo para marcar como `historical`. A revogação deixa só o rótulo.

## 2. AS IS (perfil DOU, diagnóstico)

| | 10.637 | 10.833 |
|---|---|---|
| Dispositivos "só revogação" classificados como `operative_candidate` | **7** (4 incisos, 1 artigo, 1 caput, 1 alínea) | **14** (4 incisos, 4 parágrafos, 6 alíneas) |
| Partes com nota embutida no próprio texto | 87 | 231 |
| Partes `editorial_note` | 0 | 0 |
| Seleções elegíveis (sem catálogo) | 0 | 0 |

**Riscos:**
- um dispositivo revogado aparece como candidato operativo;
- o texto da nota entra no texto do dispositivo (mistura fidelidade com interpretação).

## 3. TO BE proposto

1. **Fonte tipada e preparação própria** (`NORMAS-LEG`, no padrão L17): `prepareNormasLegPage(bytes, url, urn, versão)` emite a prova (WeakSet, congelada) ligada ao SHA do HTML e ao `representationId`. A preparação delimita, **por região exata** (spans UTF-16 no HTML preparado que voltam aos bytes), cada **nota** que atenda a todas estas condições:
   - (a) está num `<a>` com `href` em `camara.leg.br` ou `camara.gov.br` e caminho `/legin/`;
   - (b) o texto começa com `(` e termina com `)`;
   - (c) a primeira palavra pertence à gramática de nota: Redação, Revogad, Inclu, Acrescid, Vide, Produção de efeito, Vigência, Vetad, Renumerad, "Caput", Parágrafo, Inciso, Alínea;
   - (d) é o último conteúdo do bloco (só espaço depois).

   Atributos HTML **nunca** bastam sozinhos: a região vem do plano da preparação, com prova.
2. **Classes:**
   - **Nota de redação/inclusão** ("Redação dada", "acrescido", "incluído", "com nova redação"): parte própria `editorial_note`/`prohibited`. O texto do dispositivo fica **inalterado e com o mesmo contexto**. **Não** vira `historical`, porque não há redação anterior no documento.
   - **"Vide …"**: `editorial_note`/`prohibited` (remissão). Nenhum efeito sobre o dispositivo nem sobre vizinhos.
   - **Dispositivo só com rótulo + nota de revogação/veto** (nenhum outro texto no bloco): o dispositivo mantém o tipo e passa a `prohibited`, com o motivo `normas_leg_revoked_placeholder`, e a nota fica `editorial_note`.
     - Não é `historical`: não há redação a preservar.
     - `legalStatus` continua `unknown`: a nota é evidência da compilação, não prova jurídica.
   - **Revogação nunca se estende ao vizinho:** vale só para o bloco que contém a nota. Revogação "do artigo" não alcança parágrafos que têm texto próprio.
3. **Ambiguidade → exclusão conservadora:** o bloco fica fora de `operative_candidate` (vai a `unknown`) e recebe a limitação `normas_leg_note_ambiguous` quando:
   - um parêntese parece nota, mas falha em (a), (b), (c) ou (d);
   - há nota no meio do texto;
   - há duas notas que se sobrepõem;
   - o host é estranho.
4. **Preservação:** o texto canônico, os spans e o `sourceMap` não mudam: a nota vira uma parte filha com o próprio span. **A elegibilidade nunca aumenta**: o teste confere, parte a parte, que nenhuma parte não elegível antes fica elegível depois.
5. **Fora do escopo:** inferir vigência ("em vigor a partir de…"), datas de efeito ou o texto anterior a partir de notas. Nenhum atalho de vigência jurídica. Persistir análises `NORMAS-LEG` exige migration e escopo próprios, como no L17.

## 4. Contracasos (a implementar como testes antes de qualquer mudança)

| # | Caso | Esperado |
|---|---|---|
| 1 | Art. 1º com "(“Caput” do artigo com redação dada pela MP 627…)" no fim (real, 10.637) | Texto do caput igual e mesmo contexto; nota = `editorial_note`/`prohibited`; nada `historical` |
| 2 | "IV - (Revogada pela Lei nº 11.727…)" só com rótulo (real) | Inciso `prohibited` (`normas_leg_revoked_placeholder`); nota `editorial_note`; `legalStatus` `unknown` |
| 3 | Inciso revogado entre dois incisos com texto | Só o inciso revogado muda; vizinhos inalterados |
| 4 | Art. "(Revogado …)" com parágrafos que têm texto próprio | Parágrafos inalterados (sem extensão por inferência) |
| 5 | "(Vide Lei nº …)" | `editorial_note`; dispositivo inalterado |
| 6 | Parêntese legítimo no texto ("(Pasep)", "(NR)", "(Redação …" no meio do período) | Não é nota; sem mudança, ou `normas_leg_note_ambiguous` se cumprir só parte das regras |
| 7 | Nota sem `<a>` ou com host fora da Câmara | Não é região de nota; bloco `unknown` + limitação se o texto parecer nota |
| 8 | Duas notas no mesmo bloco ("Redação dada…" + "Vide…") | Duas partes `editorial_note` disjuntas; texto inalterado |
| 9 | Atributo forjado (`class="Hyperlink"`) sem plano da preparação | Ignorado (nada muda) |
| 10 | Texto original (`*-original.html`) com "(NR)" de alterações citadas | Regra atual de citação; nenhuma nota nova |
| 11 | Mesmo HTML lido como DOU | Inalterado (regra só na fonte tipada com prova) |
| 12 | Elegibilidade com catálogo NCM sintético | Conjunto elegível depois ⊆ antes |
| 13 | Dispositivo **revogador** com texto próprio ("Art. 94. Ficam revogados …") | Texto operativo do próprio ato: **não** é nota editorial nem revogação do bloco; sem mudança |
| 14 | "Redação dada …" no **texto original** (alteração de outra lei citada) | Regra atual de citação; não é nota editorial da compilação |

## 5. Prova pedida para a decisão de implementação

- Diagnóstico reprodutível desta seção, com os números do §1 e do §2 regenerados por script.
- Depois da decisão: testes dos 12 contracasos, SHA de partes/`sourceMap` das outras fontes inalterado e lote oficial sem regressão.
