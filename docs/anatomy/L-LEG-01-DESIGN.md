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
   - (b) o texto começa com `(` e termina com `)`. **Uma nota pode ocupar âncoras consecutivas** (fato real, §6): âncoras de nota separadas só por espaço ou pontuação formam **uma** nota quando a primeira abre `(` e a última fecha `)`. Sequência sem fechamento → ambígua;
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
| 15 | Nota **partida em duas âncoras** ("(“Caput” … MP nº 627, de 11/11/2013, " + "convertida na Lei nº 12.973 … 1/1/2015)"; real, §6) | **Uma** parte `editorial_note` cobrindo as duas âncoras; nunca duas notas nem texto operativo entre elas |
| 16 | Nota de revogação com data ("(Revogado **a partir de** 1/10/2008 …)"; real, §6) | Mesmo tratamento do caso 2; **nenhuma** inferência de vigência ou data de efeito; `legalStatus` `unknown` |
| 17 | Sequência de âncoras que abre `(` e não fecha | `normas_leg_note_ambiguous`; bloco `unknown`; nada recortado |

## 5. Prova pedida para a decisão de implementação

- Diagnóstico reprodutível desta seção, com os números do §1 e do §2 regenerados por script.
- Depois da decisão: testes dos 12 contracasos, SHA de partes/`sourceMap` das outras fontes inalterado e lote oficial sem regressão.

## 6. Exemplos oficiais e regiões exatas (bytes dos arquivos versionados)

Offsets no HTML **bruto** (`official-identification/leg-normas/*-atualizada.html`, UTF-8; SHA-256 dos arquivos nas metas). Intervalos semiabertos. O hash é o SHA-256 (prefixo de 16) dos bytes da região. Gerado por script offline; nenhuma requisição.

| Caso | Arquivo | Região | Offsets | SHA-256 | Texto |
|---|---|---|---|---|---|
| caso 1 | lei-10637-2002-atualizada | nota de redação (fim do bloco) | UTF-16 [16797, 17105) · bytes [16846, 17162) | `0a9cc8521414ecd8…` | (“Caput” do artigo com redação dada pela Medida Provisória nº 627, de … |
| caso 5 | lei-10637-2002-atualizada | nota "Vide" | UTF-16 [17482, 17776) · bytes [17540, 17835) | `9f2e3775696c460e…` | (Vide Lei Complementar nº 214, de 16/1/2025)… |
| caso 2 | lei-10637-2002-atualizada | dispositivo só com rótulo + revogação (bloco inteiro) | UTF-16 [20365, 20817) · bytes [20466, 20925) | `b87b82803b7a8f47…` | IV - (Revogada pela Lei nº 11.727, de 23/6/2008, publicada no DOU de 2… |
| caso 2 | lei-10637-2002-atualizada | nota de revogação | UTF-16 [20489, 20813) · bytes [20590, 20921) | `49057e79a3e71e6d…` | (Revogada pela Lei nº 11.727, de 23/6/2008, publicada no DOU de 24/6/2… |
| caso 1 | lei-10833-2003-atualizada | nota de redação (fim do bloco) | UTF-16 [16558, 16866) · bytes [16586, 16902) | `0a9cc8521414ecd8…` | (“Caput” do artigo com redação dada pela Medida Provisória nº 627, de … |
| caso 5 | lei-10833-2003-atualizada | nota "Vide" | UTF-16 [17228, 17522) · bytes [17265, 17560) | `9f2e3775696c460e…` | (Vide Lei Complementar nº 214, de 16/1/2025)… |
| caso 2 | lei-10833-2003-atualizada | dispositivo só com rótulo + revogação (bloco inteiro) | UTF-16 [21216, 21660) · bytes [21306, 21756) | `4b1ed8d3eff05831…` | IV - (Revogado a partir de 1/10/2008, de acordo com o art. 42, inciso … |
| caso 2 | lei-10833-2003-atualizada | nota de revogação | UTF-16 [21351, 21656) · bytes [21441, 21752) | `7b1bc248d40686ed…` | (Revogado a partir de 1/10/2008, de acordo com o art. 42, inciso III, … |
| caso 13 | lei-10833-2003-atualizada | dispositivo revogador com texto próprio | UTF-16 [379758, 379883) · bytes [385958, 386083) | `430e8a9f0a0d629a…` | Art. 94. Ficam revogados:… |
| caso 15 (nota partida) | lei-10637-2002-atualizada | 1ª âncora | UTF-16 [16797, 17105) · bytes [16846, 17162) | `0a9cc8521414ecd8…` | (“Caput” do artigo com redação dada pela Medida Provisória nº 627, de … |
| caso 15 (nota partida) | lei-10637-2002-atualizada | 2ª âncora | UTF-16 [17145, 17427) · bytes [17202, 17485) | `eb342badc4232441…` | convertida na Lei nº 12.973, de 13/5/2014, em vigor a partir de 1/1/20… |
| caso 15 (nota partida) | lei-10833-2003-atualizada | 1ª âncora | UTF-16 [16558, 16866) · bytes [16586, 16902) | `0a9cc8521414ecd8…` | (“Caput” do artigo com redação dada pela Medida Provisória nº 627, de … |
| caso 15 (nota partida) | lei-10833-2003-atualizada | 2ª âncora | UTF-16 [16906, 17188) · bytes [16942, 17225) | `eb342badc4232441…` | convertida na Lei nº 12.973, de 13/5/2014, em vigor a partir de 1/1/20… |

**Leitura:** os casos 1 e 15 são o **mesmo** texto nas duas leis (a nota do art. 1º se repete; o hash coincide). Uma nota real pode ocupar duas âncoras, e isso motivou a revisão da regra (b).

## 7. Procedência ligada aos bytes e à representação

- O plano de regiões é calculado pela preparação a partir dos **bytes** do arquivo cuja meta (URL, URN, versão, SHA-256, bytes, data) está registrada. Ele é emitido por referência (WeakSet, congelado) e ligado ao SHA do HTML preparado e ao `representationId`.
- Vale **só** para a representação "versão atualizada" do normas.leg.br. O texto original e o HTML do Planalto não usam este plano: o Planalto tem layout próprio e, nos bytes HTTP recebidos, charset não declarado.
- Atributos HTML sozinhos nunca valem como prova (contracaso 9).

## 8. Preservação

O texto canônico, a ordem, os offsets e o `sourceMap` não mudam. A nota vira uma parte filha com o próprio span (ou spans, no caso de nota partida). O dispositivo mantém o próprio span sem o trecho da nota. Teste de não regressão: o SHA de texto, partes e `sourceMap` das outras fontes (lote RFB, Sefaz-SP, CONFAZ) fica idêntico.

## 9. Critérios de aceite e impactos esperados

**Aceite:**
- os 17 contracasos passam;
- a elegibilidade depois é subconjunto da de antes;
- `legalStatus` continua `unknown` em todas as partes;
- as outras fontes ficam inalteradas;
- os números do §2 são regenerados por script.

**Impactos esperados (estimativa a medir na implementação):**
- os dispositivos "só revogação" deixam de ser `operative_candidate` (7 e 14 hoje);
- as notas passam a partes `editorial_note`. Fato contado: 175 e 470 âncoras da Câmara. O número de notas depois de unir as partidas **será medido** na implementação, e não é estimado aqui;
- texto e `sourceMap` sem alteração;
- nenhum `historical` novo.

## 10. Adendo — contracasos da outra sessão (rastreável; frente única)

**Origem:** tribusca-control@`335160c7`, republicado sem perda de encoding em `c90752ec`, `docs/investigations/e9-inputs/20261107-night/overnight-review/L-LEG-01-ADDENDUM.md` e `lleg-lexical-proof.json`. Não substitui este desenho.

**Incorporado:**
- **Lexemas por representação** (contagem lexical, não contagem de notas): 10.637 original 2/0/0, atualizada 34/20/15; 10.833 original 11/1/0, atualizada 94/37/37 ("Redação dada" / "Revogad" / "Vide").
- **Ponto metodológico:** os spans lexicais provam só a ocorrência da palavra e **não** delimitam a nota. Isso coincide com o §6, que delimita a região da nota inteira.
- **Conferência cruzada** (bytes da versão atualizada da 10.637): "redação dada" [17089, 17103) está dentro da nota do caso 1 [16846, 17162); "Vide" [17780, 17784) dentro da região do caso 5 [17540, 17835); "Revogada" [20771, 20779) dentro da nota do caso 2 [20590, 20921). **As duas fontes são consistentes.**
- **Novos contracasos (18–29):**
  - 18: host da Câmara enganoso por sufixo (`camara.leg.br.example`);
  - 19: `href` relativo resolvido contra a origem real;
  - 20: entidade HTML dentro da palavra;
  - 21: BOM (só os arquivos *originais* têm; os offsets do §6 são das versões *atualizadas*, sem BOM);
  - 22: caractere fora do BMP antes da região;
  - 23: nota entre duas frases operativas;
  - 24: parênteses aninhados ou aspas;
  - 25: citação de redação antiga;
  - 26: duas notas consecutivas;
  - 27: texto revogado preservado × placeholder sem texto;
  - 28: hash ou tamanho alterado;
  - 29: mesma URN com representação diferente.

  Em todos: decisão explícita do escopo da região, ou ambiguidade declarada; nunca classificar o parágrafo inteiro por aproximação.
- **Critérios extras:** decodificação sustentada pela captura (sem heurística); "Redação dada"/"Vide" sozinhos nunca produzem `historical`; redação anterior exige o texto anterior presente e uma fronteira demonstrada.

**Achado na entrega e resolução:**
- No commit `335160c7`, o `lleg-lexical-proof.json` não era JSON válido (aspas curvas viraram retas sem escape; acentos corrompidos).
- A outra sessão republicou com UTF-8 preservado no commit `c90752ec` (15/15 arquivos conferidos por ela).
- Nesta sessão, o teste `lleg-proof.test.cjs` dela, executado contra os **nossos** bytes de `leg-normas/`, deu **4/4 PASS**: identidade (SHA e tamanho) e offsets lexicais em bytes e UTF-16, com BOM.
- É conferência cruzada independente da identidade e dos offsets lexicais, **não** da classificação.

## 11. Contrato de spans e ownership (fixado antes do código; #116 c.6708512598 §7)

Esta seção substitui qualquer redação anterior ambígua sobre o "span do pai".

1. **Texto canônico global, coordenadas de origem e `sourceMap`:** **idênticos** com e sem a L-LEG-01. A renderização do HTML não muda, e nada é recortado do texto.
2. **Parte do dispositivo** (artigo, parágrafo, inciso, alínea, item): mantém **o mesmo span** de hoje, que cobre o bloco inteiro, nota incluída. O tipo não muda. O contexto só muda em dois casos:
   - placeholder revogado comprovado → `prohibited` (`normas_leg_revoked_placeholder`);
   - nota ambígua no bloco → `unknown` (`normas_leg_note_ambiguous`). Nunca promove.
3. **Parte nova `editorial_note`:**
   - uma por região de nota do plano; uma nota partida em âncoras consecutivas gera **uma** parte;
   - span = `[início da 1ª âncora, fim da última âncora)` em coordenadas canônicas (os `span` dos próprios nós);
   - `sourcePointers` = os intervalos brutos das âncoras;
   - `parentId` = a parte do bloco que contém a nota;
   - contexto `prohibited`; motivo `normas_leg_editorial_note` ou `normas_leg_vide`.
4. **Ownership da cobertura:** vale a regra já existente do leitor (o menor span estrutural é o dono). O texto da nota passa a pertencer à parte `editorial_note`, e o resto do bloco continua com o dispositivo. A soma da cobertura não muda.
5. **Identidade de partes:** a criação de partes novas **não** fecha a continuação do caput (regra D02). Os `id` e `order` sequenciais das partes **seguintes** podem mudar. **Não se promete identidade de partes que mudam.** As comparações usam regiões (spans canônicos), tipos e contextos.
6. **Elegibilidade:** é comparada **por regiões e seleções**, nunca por ids. O conjunto de regiões elegíveis depois tem de estar contido no de antes, e nenhuma seleção nova pode surgir.
7. **Regressão das demais fontes:** compara-se o payload (texto, partes sem ids, contextos, `sourceMap`, cobertura, elegibilidade por regiões), **sem** `outputHash` e identidade, que mudam legitimamente com o build.
8. **Procedência:** o plano é emitido pela preparação (WeakSet, congelado) e ligado ao SHA dos bytes, ao HTML, à URN, à versão e ao `representationId`. Cópia, forja ou divergência → **a fonte tipada recusa a leitura** (`NormasLegProvenanceError`, como a L17 faz com o portal Sefaz-SP); nas demais fontes nada muda. *(Esclarecido na implementação, §12: "nenhuma regra aplicada" passou a ser recusa fail-closed, mais restritiva.)*

## 12. Implementação offline (branch `claude/anat-lleg01`; #116 c.6708512598 §7)

**O que existe agora:**
- `src/modules/anatomy/normas-leg-preparation.ts`: `prepareNormasLegPage({resourceId, url, urn, version, bytes, expected?})` emite o plano congelado (WeakSet) e `verifyNormasLegPreparation` o confere. O HTML **não** é alterado.
- Fonte tipada `NORMAS-LEG` (perfil fixo, como `SEFAZ-SP-PORTAL`): sem a prova emitida para este HTML e este `representationId`, o leitor **recusa** (fail-closed).
- Leitor (`readers.ts`): só no bloco planejado e só pelo plano:
  - nota → parte filha `editorial_note`/`prohibited` (motivo `normas_leg_editorial_note` ou `normas_leg_vide`), com o span canônico das âncoras e um `sourcePointer` por âncora;
  - o pai é a parte que **é** o bloco (o `caput`, no bloco de abertura de artigo/cláusula), para que irmãos nunca se sobreponham. A nota não fecha a continuação do caput (D02);
  - placeholder revogado comprovado em dispositivo → `prohibited` (`normas_leg_revoked_placeholder`);
  - bloco ambíguo → `unknown` (`normas_leg_note_ambiguous`) e limitação. Nada é recortado.
- Sem persistência, migration, API, flag ou promoção. `legalStatus` sempre `unknown`. Nenhum `historical`.

**Medido nos arquivos reais (regenerado pelo teste `anatomy.normas-leg`):**

| | 10.637 atualizada | 10.833 atualizada |
|---|---|---|
| Notas (regiões) | 106 | 314 |
| Âncoras nas notas | 134 | 391 |
| Notas partidas (mais de uma âncora) | 25 | 66 |
| Placeholders revogados/vetados | 23 | 40 |
| Blocos ambíguos → `unknown` | 30 | 3 |
| `historical` | 0 | 0 |
| Texto, `sourceMap` e cobertura **contabilizada** (`textLength`/`accountedLength`) × leitura DOU | idênticos | idênticos |
| **Ownership** da cobertura (`segments`, `recognizedLength`) × leitura DOU | muda **de propósito**: o texto da nota passa à parte `editorial_note` (§11.4) | idem |

Os 30 ambíguos da 10.637 são, em sua maioria, "(VETADO)" em texto simples (sem âncora da Câmara, logo sem prova pela regra (a)). Também entram:
- duas âncoras com `href` quebrado (o próprio texto da nota como `href`, que resolve para normas.leg.br);
- uma nota de rodapé "[1]".

O §2 estimava 7 e 14 dispositivos "só revogação". O número medido é maior, porque inclui os vetos com âncora ("(VETADO na Lei nº …)") e os incisos/alíneas de artigos revogados.

**Refinamentos por medição (desvios do §3, declarados para a revisão; não autoaprovados):**
1. **Gramática (c):** acrescentado `Artigo` ("(Artigo acrescido pela Lei …)": 1 e 10 ocorrências). Os substantivos estruturais (Caput, Parágrafo, Inciso, Alínea, Artigo) exigem também um verbo de nota dentro do grupo (redação, revogad, acrescid, incluíd, vetad, vide, renumerad, efeito, vigência, vigor). Assim, "(inciso I do art. 3º)" nunca é nota.
2. **Separador da nota partida (b):** além de espaço e [,;.], é aceito **um** conectivo "e" isolado entre âncoras. Caso real: "(Parágrafo acrescido pela Lei nº 10.996" + " e " + "com nova redação dada pela Lei nº 11.307)".
3. **Host (a):** além de `/legin/`, é aceito o visualizador antigo do LegIn **só** em `camara.gov.br` (`/internet/legislacao/legin.html/textos/visualizarTexto.html` e `/legislacao/legin.html/…`). Hosts parecidos (`camara.leg.br.example`, `evilcamara.leg.br`), `href` relativo e esquema não http(s) continuam recusados.
   - *Efeito medido dos itens 2 e 3 juntos:* blocos ambíguos 37 → 30 (10.637) e 36 → 3 (10.833); notas 99 → 106 e 281 → 314.
4. **Grupos numa âncora só:** "(Artigo acrescido …) (Vide …)" é uma região (a âncora), com classe `editorial`; casos reais: 1 + 2. A nota nunca é partida dentro de uma âncora.
5. **Rótulo + só "Vide":** um dispositivo com rótulo e apenas uma nota que não é de revogação (real: "§3º (Vide Lei Complementar nº 214 …)") é ambíguo (`label_only_without_revocation`), não placeholder.
6. **§11.8:** a falta, cópia ou divergência da prova faz a fonte tipada **recusar** a leitura, em vez de "nenhuma regra aplicada".

**Contracasos → testes** (`test/anatomy.normas-leg.unit.test.ts`, 17 testes):

| Casos | Teste |
|---|---|
| 1, 8, 15 | art. 1º real da 10.637: nota partida = uma parte; Vide separada; offsets e SHA do §6 |
| 2, 16 | placeholders reais das duas leis; sem inferência de data; regiões do §6 |
| 3, 4 | revogação não se estende a vizinhos nem aos parágrafos do artigo |
| 5, 8, 24, 26 | Vide, duas notas, parênteses aninhados, dois grupos numa âncora |
| 6, 7 | parênteses legítimos; nota sem âncora ou com host externo → `unknown` |
| 9, 11, 28 | sem prova, cópia, objeto parecido, HTML alterado → recusa; lido como DOU, nada muda; hash/tamanho divergente → recusa |
| 10, 14, 29 | texto original recusado na preparação e sem nota nova; outra representação recusada |
| 12 | catálogo NCM sintético: candidatos depois ⊆ antes; o NCM dentro da nota deixa de ser candidato |
| 13 | art. 94 real da 10.833 ("Ficam revogados"): inalterado |
| 17, 23 | nota sem fechamento e nota no meio do período → ambíguas, nada recortado |
| 18, 19 | host enganoso e `href` relativo; visualizador antigo do LegIn |
| 20, 21, 22 | entidade, BOM, caractere fora do BMP: regiões exatas em UTF-16 e bytes |
| 25 | citação de redação anterior ("(NR)") sem nota |
| 27 | texto preservado + revogação ≠ placeholder |
| §11 | arquivos reais: texto, `sourceMap`, cobertura e caput iguais; só blocos planejados mudam, e só para baixo; contagens acima |
| regressão | 37 entradas das demais fontes (lote RFB, Sefaz-SP, CONFAZ, DOU, Planalto e normas.leg.br lido como DOU) **idênticas** à linha de base gravada antes da mudança (`docs/anatomy/lleg-regression-baseline.json`, sem `identity`/`analysisId`/`outputHash`) |

**Identidade do motor:** `0e009431` → `9235a810`. A mudança vem de **código novo** (`normas-leg-preparation.ts` entra na lista; leitor, motor e perfis mudam), não é "só hash". Para as **demais fontes**, o lote RFB e a linha de base das amostras mudaram **só** em `engineBuildHash`/`outputHash`; o conteúdo delas é idêntico (regressão de 37 entradas).

**Decisões da revisão (#305 c.6709334910):**
- Os 6 refinamentos foram **aprovados** no escopo offline desta fonte. A preparação é evidência local, **não** prova de coleta oficial.
- As contagens acima são medições do EXEC até a execução de CI conferida.
- **Matriz E9:** as **duas versões atualizadas** passam a `read` porque `collectSamples` agora as lê de fato por `prepareNormasLegPage` + `NORMAS-LEG`, com hash, URN, versão e `representationId` preservados e conferidos no teste.
  - Elas continuam `validated: false` e fora da linha de base das amostras: a validação exige baseline, invariantes e teste próprios.
  - Nenhuma é `accepted`.
  - Os textos originais não têm plano: só capturados e identificados, com a leitura DOU como diagnóstico.
  - Cobertura da matriz inalterada: 10/61.

**Pendências:** CI do HEAD e recheck proporcional; decisão sobre `validated` das versões atualizadas.
