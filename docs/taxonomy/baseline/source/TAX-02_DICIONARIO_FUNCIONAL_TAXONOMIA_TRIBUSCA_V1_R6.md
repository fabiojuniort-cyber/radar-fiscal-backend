# TAX-02 — Dicionário funcional da Taxonomia Tributária TriBusca v1 — R6

**Estado:** `proposed`, correção incremental R6 após reprovação TAX-03-R5; TAX-01 aprovada é o contrato. **Corte de pesquisa:** 29/09/2026. **Classe:** R2, mudança material de vocabulário sujeita a recheck independente. Nenhum catálogo foi importado e nenhuma classificação foi executada. O inventário abaixo é uma **semente funcional**, não declaração de exaustividade jurídica, cobertura de coleta, vigência individual ou aprovação final dos conceitos.

> **Revisão R6 — 29/09/2026.** Esta revisão deriva da R5 reprovada no PR #24, SHA `c66ed4574b8daf468d05fe9e360c185544dd1bd9`, e corrige incrementalmente apenas B1–B4 e consequências quantitativas/documentais diretas. Tudo permanece `proposed`. A R6 não se autoaprova, não libera TAX-04 e não altera os pontos materiais já aprovados na revisão R5. As decisões vigentes desta revisão estão consolidadas no §24.

## 1. Sumário executivo e regras de leitura

Este dicionário define identidades canônicas para tributos, temas, mecanismos, regimes, operações, documentos, obrigações, segmentos, produtos, sujeitos, eventos e impactos. CNAE, NCM, município, órgão e leiaute permanecem referências oficiais versionadas, ligadas ao conceito quando há prova. Não existe propagação automática por nenhuma relação. Classificação global de publicação e afinidade/impacto para um cliente permanecem separados. O vocabulário pode representar ISS sem que um conector municipal esteja ativo. `UNMAPPED` ou abstenção são resultados corretos diante de lacuna ou ambiguidade.

**Contrato de registro compacto.** Cada linha das tabelas seguintes é um registro canônico individual. A coluna `Definição; + / −` contém definição funcional, exemplo positivo e contraexemplo; `−` não afirma que o conceito jamais pode coexistir com o termo, apenas que o termo isolado não prova aquele conceito. A coluna `Âncora` indica autoridade/evidência e tipo (`O` oficial, `T` TriBusca, `H` híbrida); as chaves de fonte e seus links estão na matriz §3, inclusive as chaves-marcador `TriBusca`, `lei específica` e `ato oficial` (§3.1). `T` só se aplica quando a âncora é exclusivamente `TriBusca`; qualquer fonte oficial na âncora torna o registro `H`. A coluna `Vínculo/alerta` indica pai, relação, ambiguidade e nota temporal relevantes. **Metadados explícitos herdados por todas as linhas:** dimensão = prefixo do código (antes do primeiro ponto), inclusive em tabelas que misturam facetas; código = primeira coluna; rótulo = segunda; status = `proposed`; pai = nenhum se não houver `pai:`; relações = nenhuma se não houver `rel:`; aliases = nenhum aprovado se não houver entrada no §15; termos relacionados = nenhum obrigatório se não houver `rel:`; ambiguidade e observação temporal = “não identificada nesta triagem” se não constarem em `Vínculo/alerta`. A evidência de um conceito TriBusca é a justificativa funcional desta definição e dos exemplos, ancorada nas fontes indicadas; isso **não** atribui status de definição legal ao termo TriBusca. `proposed` significa que TAX-03 ainda pode corrigir ou rejeitar a linha.

**Identidade:** códigos ASCII minúsculos `dimensao.termo_semantico`; ponto não gera hierarquia. Códigos externos pertencem a correspondências com mantenedor, catálogo, edição, vigência, código e URL, nunca à identidade interna. Rótulo pode mudar, significado do código não. Subclasses ou equivalências só existem onde explicitamente aprovadas; `related_to`/`maps_to_official` jamais inferem classificação. Os tipos de relação aprovados na TAX-01 permanecem disponíveis; §15 distingue os efetivamente usados nesta semente dos ainda não instanciados. Um termo lexical ambíguo não autoriza classificar sozinho. Versões de dicionário, catálogo e publicação são independentes; reclassificação futura é auditável.

### Decisões semânticas transversais

- **Tema** é assunto de norma; **mecanismo/tratamento** é técnica jurídica ou tratamento fiscal efetivo descrito com condições; **regime** é conjunto normativo de regras de enquadramento ou apuração. “Substituição tributária”, “diferimento” e “suspensão” podem gerar `theme.*` quando a norma discute o assunto e `treatment.*` quando institui/aplica a técnica; não são aliases nem duplicação de identidade: têm predicados diferentes. A relação `about` entre os dois é informativa, sem propagação.
- **Crédito presumido** e **benefício fiscal** não recebem `narrower_than` na v1: há usos legais/contextos que exigem análise da hipótese e do tributo. A relação é `related_to`, com evidência. “Crédito” sozinho é mais amplo e não comprova “presumido”.
- **Operação** expressa ação econômica/fiscal; âmbito (`operation_scope.internal`, `.interstate`, `.international`), destino, finalidade e titularidade são atributos separados. `interstate` não vira operação combinatória.
- **Vigência** é fato temporal qualificado por dispositivo, jurisdição, condição e fonte, não tag permanente. **Relação entre atos** é aresta dirigida, não sinônimo de evento ou tipo de ato.
- **Impacto** global só pode ser potencial e fundamentado. Nome de software instalado, CNPJ, atividade efetiva do estabelecimento, relevância e providência concreta de cliente nunca entram no conceito global.

## 2. Modelo mínimo de uma afirmação e correspondência

Uma afirmação de classificação futura precisa de: publicação e versão de conteúdo; conceito e versão do dicionário; trecho/dispositivo oficial; estado `CONFIRMED`, `SUGGESTED`, `AMBIGUOUS`, `UNMAPPED` ou `NOT_APPLICABLE`; método/revisor; data; jurisdição e condições quando cabíveis. `UNMAPPED` deve carregar termo, dimensão candidata, contexto e evidência para curadoria, sem criar conceito. Uma correspondência externa exige `authority`, `catalog`, `edition`, `official_code`, rótulo da edição, `valid_from/to` quando conhecido, URL, data de consulta, tipo (`exact`, `broader`, `narrower`, `overlap`), justificativa e revisão. Não há correspondência implícita via alias.

Para normas com vários dispositivos, não colapsar a conclusão para a publicação inteira se somente um dispositivo sustenta o fato. Eventos e efeitos temporais podem ter alvos e datas diferentes. Catálogos “atuais” não são retroaplicados. Referência oficial sem vigência verificável fica com intervalo desconhecido, não com intervalo inventado.

## 3. Matriz de fontes oficiais e escopo de autoridade

Consulta das páginas da matriz principal: **28/09/2026**. As chaves de §3.1 e §3.3 têm verificação individual indicada nos respectivos parágrafos; §3.4 registra as reconferências pontuais da R4. `ed.` indica a edição identificada; “compilada na consulta” não é uma versão imutável e requer arquivamento/verificação antes da TAX-04. Não se inferiu início/fim de vigência de um código particular a partir da página geral.

| Chave | Fonte/mantenedor e edição consultada | Uso e limite | URL oficial |
|---|---|---|---|
| CF | Presidência/Planalto; Constituição compilada na consulta | competências e espécies; verificar redação e eficácia do dispositivo na data da norma | [Constituição](https://www.planalto.gov.br/ccivil_03/constituicao/constituicaocompilado.htm) |
| CTN | Presidência/Planalto; Lei 5.172/1966 compilada na consulta | conceitos gerais, obrigação, crédito, sujeitos, lançamento | [CTN](https://www.planalto.gov.br/ccivil_03/leis/l5172compilado.htm) |
| LC214 | Presidência/Planalto; LC 214/2025 compilada na consulta, com alterações posteriores | IBS, CBS, IS e tratamentos; vigência por dispositivo, sem retroagir edição | [LC 214](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214compilado.htm) |
| LC116 | Presidência/Planalto; LC 116/2003 compilada na consulta | estrutura nacional do ISS/lista de serviços; legislação municipal continua própria | [LC 116](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp116.htm) |
| LC123 | Presidência/Planalto; LC 123/2006 compilada na consulta | Simples Nacional e enquadramento | [LC 123](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp123.htm) |
| RIR | Presidência/Planalto; Decreto 9.580/2018 consultado | formas de tributação de renda/lucro; efeitos conforme dispositivo/lei de base | [Regulamento do Imposto de Renda](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/decreto/d9580.htm) |
| CNAE | IBGE/CONCLA; CNAE-Subclasses **2.3**, estrutura e correspondências da edição | atividade econômica oficial; seções/divisões/grupos/classes/subclasses; não é segmento | [IBGE](https://www.ibge.gov.br/estatisticas/metodos-e-classificacoes/classificacoes-e-listas-estatisticas/9078-classificacao-nacional-de-atividades-economicas.html/), [CONCLA](https://cnae.ibge.gov.br/classificacoes/download-concla/8265-download) |
| NCM | Receita Federal/Sistema Classif; tabela e histórico consultados, edição do código a registrar no vínculo | mercadorias; produto comercial não determina código de oito dígitos | [NCM](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/ncm), [Classif](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/classif), [histórico](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/historico-ncm-nomenclatura-comum-do-mercosul) |
| NBS | MDIC/RFB; NBS e NEBS 2.0 consultadas | referência oficial de serviços/intangíveis sob ótica de produto; **não é** NCM nem lista de incidência do ISS | [MDIC NBS](https://www.gov.br/mdic/pt-br/assuntos/sdic/comercio-e-servicos/nbs-nomenclatura-brasileira-de-servicos), [painel de códigos](https://www.gov.br/mdic/pt-br/assuntos/sdic/comercio-e-servicos/nbs-nomenclatura-brasileira-de-servicos/painel-de-codigos-nbs/painel-de-codigos-nbs/) |
| CFOP | CONFAZ/ENCAT, SINIEF e SPED; MOC NF-e 7.0 e Guia EFD ICMS/IPI da edição consultada | código fiscal de operação/prestação em documento/escrituração; seu uso depende da perspectiva entrada/saída, tributo e edição; não é vocabulário econômico completo | [MOC NF-e 7.0](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-anexo-i-leiaute-e-rv.pdf), [Guia EFD ICMS/IPI](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/a11-guia-pratico-efd-versao-3-1-2-anexo-viii.pdf) |
| IBGE | IBGE; cadastro de UF/municípios consultado | 27 UFs; códigos municipais e alterações históricas; cobertura de fonte separada | [municípios](https://www.ibge.gov.br/explica/codigos-dos-municipios.php), [UFs](https://www.ibge.gov.br/geociencias/cartas-e-mapas/mapas-de-referencia/15816-politico.html?lang=pt-BR) |
| SIORG | Ministério da Gestão; sistema consultado | órgãos do Executivo federal **apenas**; demais entes exigem fontes próprias | [SIORG](https://www.gov.br/gestao/pt-br/assuntos/gestaoeinovacao/modelos-organizacionais/estruturas-organizacionais/Sistema-informatizado-siorg/sistema-informatizado-siorg/) |
| DF-e | ENCAT/CONFAZ e portais dos DF-e; modelos, ajustes, manuais e notas técnicas por edição | família documental, modelo e leiaute; não confundir modelo com obrigação | [CONFAZ](https://www.confaz.fazenda.gov.br/legislacao/ajustes), [NF-e/NFC-e 55/65](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-anexo-i-leiaute-e-rv.pdf), [CT-e/CT-e OS/GTV-e 57/67/64](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/a41-moc_cte_anexo-i_leiaute_e_regras_de_validacao_v4-00-anexo-vi.pdf), [MDF-e 58](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc_mdfe_visaogeral_v3-00a.pdf), [BP-e 63](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc_bpe_visaogeral_v1-00b.pdf), [NF3-e 66](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc_nf3e_visaogeral_v1-00a-1.pdf), [NFCom 62](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/visao-geral-moc-nfcom.pdf) |
| NFSE | Comitê Gestor/Portal NFS-e; documentação de produção e histórico consultados | padrão nacional de NFS-e, versões; municípios podem ter sistemas próprios | [documentação](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica) |
| SPED | Receita Federal/SPED; documentação por módulo/edição | plataforma e escriturações; registrar leiaute individual | [SPED](https://www.gov.br/sped/pt-br/assuntos/modernizacao-da-relacao-fisco-contribuinte), [EFD ICMS/IPI](https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-icms-ipi), [ECF](https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/ecf) |
| DCTF | Receita Federal; manual DCTFWeb e MIT consultados | declaração e módulo de inclusão, não dois documentos fiscais | [DCTFWeb/MIT](https://www.gov.br/receitafederal/pt-br/assuntos/orientacao-tributaria/declaracoes-e-demonstrativos/DCTFWeb) |
| ESOC | eSocial/governo federal; documentação consultada | sistema de informações trabalhistas/previdenciárias/fiscais | [eSocial](https://www.gov.br/esocial/pt-br/centrais-de-conteudo/conheca-o-esocial) |
| ADUANA | Receita Federal; manuais/regimes consultados, edição normativa individual pendente | trânsito, admissão temporária e drawback; não aplicar sem modalidade/ato concessório | [manuais](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/manuais), [drawback](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/regimes-e-controles-especiais/regimes-aduaneiros-especiais/drawback) |
| DERE | Receita Federal e CGIBS; pacote técnico DeRE e atos de 2026 | declaração de regimes específicos: documento fiscal e obrigação acessória em papéis distintos | [DeRE](https://www.gov.br/sped/pt-br/assuntos/documentos-fiscais/dere), [Ato Conjunto 3/2026](https://www.gov.br/sped/pt-br/assuntos/comunicados/dere/receita-federal-e-cgibs-publicam-ato-conjunto-no-3-2026-com-nova-etapa-da-documentacao-tecnica-da-dere) |
| SEFAZSP | Sefaz-SP; página GIA consultada | exemplo de obrigação estadual, não catálogo nacional | [GIA](https://portal.fazenda.sp.gov.br/servicos/gia) |

### 3.1 Chaves acrescentadas na revisão R1

As chaves abaixo eram usadas em linhas do dicionário sem constar da matriz. **Na R1**, as URLs foram incluídas sem verificação. A R2 confirmou somente a Lei 6.404/1976 na fonte primária (§3.2); as demais chaves continuam com consulta/edição pendentes para TAX-03 antes de citação como edição consultada.

| Chave | Fonte/mantenedor | Uso e limite | URL oficial |
|---|---|---|---|
| CONFAZ | CONFAZ; convênios, ajustes SINIEF e protocolos | atos de ICMS e de documentos; ratificação/incorporação por UF não presumidas | [legislação CONFAZ](https://www.confaz.fazenda.gov.br/legislacao) |
| LC190 | Presidência/Planalto; LC 190/2022 | DIFAL do ICMS a não contribuinte; ler com CF art. 155, §2º, VII e VIII (EC 87/2015) | [LC 190](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp190.htm) |
| L10336 | Presidência/Planalto; Lei 10.336/2001 | Cide-Combustíveis | [Lei 10.336](https://www.planalto.gov.br/ccivil_03/leis/leis_2001/l10336.htm) |
| LSA | Presidência/Planalto; Lei 6.404/1976 | incorporação, fusão e cisão (arts. 227–229) | [Lei 6.404](https://www.planalto.gov.br/ccivil_03/leis/l6404consol.htm) |
| CC | Presidência/Planalto; Código Civil (Lei 10.406/2002) | contratos civis: doação, troca, comodato, mútuo | [Código Civil](https://www.planalto.gov.br/ccivil_03/leis/2002/l10406compilada.htm) |
| `TriBusca` | Marcador: definição funcional desta taxonomia | não é fonte legal; isolada gera tipo `T` | — |
| `lei específica` | Marcador: lei do tributo/ente ainda não identificada | pendência de TAX-03; não autoriza citar dispositivo | — |
| `ato oficial` | Marcador: o próprio ato classificado | a evidência é o trecho do ato, não esta matriz | — |

Fontes estaduais e municipais competentes **não** formam um catálogo nacional único de leis, órgãos, declarações ou NFS-e locais. Cada vínculo local futuro guardará ente, ato, edição, vigência e URL. Portais oficiais são índice de descoberta; para classificação jurídica concreta vale o ato e seu dispositivo aplicável.

### 3.2 Fontes primárias reconferidas na R2

Em 28/09/2026, foram reconferidas as páginas da [Receita sobre NCM](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/ncm) (21 seções, 96 capítulos, classificação por regras e notas), do [IBGE sobre CNAE-Subclasses 2.3](https://www.ibge.gov.br/estatisticas/metodos-e-classificacoes/classificacoes-e-listas-estatisticas/9078-classificacao-nacional-de-atividades-economicas.html/) e sua [estrutura e correspondência](https://cnae.ibge.gov.br/classificacoes/download-concla/8265-download), do [MDIC sobre NBS 2.0](https://www.gov.br/mdic/pt-br/assuntos/sdic/comercio-e-servicos/nbs-nomenclatura-brasileira-de-servicos), da [LC 214 compilada](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214compilado.htm) e da [Lei 6.404/1976, arts. 227–229](https://www.planalto.gov.br/ccivil_03/leis/l6404consol.htm). Isso confirma a **existência e escopo geral** das referências, não uma edição congelada nem correspondências oficiais dos novos conceitos. A expansão R2 foi ancorada como vocabulário TriBusca (`T`) justamente para não fazer tais correspondências sem evidência.

### 3.3 Chaves acrescentadas na R3

Usadas pelas linhas novas da R3. **Verificado na R3** só o que está marcado; as demais URLs têm consulta pendente para TAX-03, como em §3.1.

| Chave | Fonte/mantenedor | Uso e limite | URL oficial |
|---|---|---|---|
| L8212 | Presidência/Planalto; Lei 8.212/1991 | custeio da seguridade: patronal, RAT, produtor rural | [Lei 8.212](https://www.planalto.gov.br/ccivil_03/leis/l8212cons.htm) |
| L12546 | Presidência/Planalto; Lei 12.546/2011 | CPRB (arts. 7º a 9º-A) | [Lei 12.546](https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2011/lei/l12546.htm) |
| L14973 | Presidência/Planalto; Lei 14.973/2024 | **verificado na R3:** art. 9-A da Lei 12.546 (reoneração 2025–2027) e art. 43 (declaração de benefícios fiscais) | [Lei 14.973](https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2024/lei/l14973.htm) |
| L10865 | Presidência/Planalto; Lei 10.865/2004 | PIS/Cofins-Importação | [Lei 10.865](https://www.planalto.gov.br/ccivil_03/_ato2004-2006/2004/lei/l10.865.htm) |
| L9718 | Presidência/Planalto; Lei 9.718/1998 | PIS/Cofins cumulativo | [Lei 9.718](https://www.planalto.gov.br/ccivil_03/leis/l9718compilada.htm) |
| L10637/L10833 | Presidência/Planalto; Leis 10.637/2002 e 10.833/2003 | PIS e Cofins não cumulativos | [Lei 10.637](https://www.planalto.gov.br/ccivil_03/leis/2002/l10637.htm), [Lei 10.833](https://www.planalto.gov.br/ccivil_03/leis/2003/l10.833.htm) |
| L10168 | Presidência/Planalto; Lei 10.168/2000 | Cide-Royalties/Remessas | [Lei 10.168](https://www.planalto.gov.br/ccivil_03/leis/l10168.htm) |
| L10893 | Presidência/Planalto; Lei 10.893/2004 | AFRMM | [Lei 10.893](https://www.planalto.gov.br/ccivil_03/_ato2004-2006/2004/lei/l10.893.htm) |
| MP2228 | Presidência/Planalto; MP 2.228-1/2001 | Condecine | [MP 2.228-1](https://www.planalto.gov.br/ccivil_03/mpv/2228-1.htm) |
| L9998 / L10052 | Presidência/Planalto; Leis 9.998/2000 e 10.052/2000 | Fust e Funttel | [Lei 9.998](https://www.planalto.gov.br/ccivil_03/leis/l9998.htm), [Lei 10.052](https://www.planalto.gov.br/ccivil_03/leis/l10052.htm) |
| DL288 | Presidência/Planalto; Decreto-Lei 288/1967 | Zona Franca de Manaus | [DL 288](https://www.planalto.gov.br/ccivil_03/decreto-lei/del0288.htm) |
| L11488 | Presidência/Planalto; Lei 11.488/2007 | Reidi | [Lei 11.488](https://www.planalto.gov.br/ccivil_03/_ato2007-2010/2007/lei/l11488.htm) |
| L14596 | Presidência/Planalto; Lei 14.596/2023 | preços de transferência | [Lei 14.596](https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2023/lei/l14596.htm) |
| L13988 | Presidência/Planalto; Lei 13.988/2020 | transação tributária | [Lei 13.988](https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2020/lei/l13988.htm) |
| L5764 | Presidência/Planalto; Lei 5.764/1971 | sociedades cooperativas e ato cooperativo | [Lei 5.764](https://www.planalto.gov.br/ccivil_03/leis/l5764.htm) |
| LC109 / LC126 | Presidência/Planalto; LC 109/2001 e LC 126/2007 | previdência complementar; resseguro | [LC 109](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp109.htm), [LC 126](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp126.htm) |
| L14478 | Presidência/Planalto; Lei 14.478/2022 | prestadores de serviços de ativos virtuais | [Lei 14.478](https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2022/lei/l14478.htm) |
| L9656 / L14193 | Presidência/Planalto; Leis 9.656/1998 e 14.193/2021 | planos de saúde; SAF | [Lei 9.656](https://www.planalto.gov.br/ccivil_03/leis/l9656.htm), [Lei 14.193](https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14193.htm) |
| CGSN | Comitê Gestor do Simples Nacional; resoluções | PGDAS-D, Defis, DASN-Simei | [Portal do Simples](https://www8.receita.fazenda.gov.br/simplesnacional/) |
| RFB | Receita Federal; instruções normativas por obrigação | PER/DCOMP, DMED, DIMOB, DOI, e-Financeira, DIRBI, DIRF | [normas RFB](https://normas.receita.fazenda.gov.br/) |
| SISCOMEX | Portal Único Siscomex | DUIMP e DU-E | [Siscomex](https://www.gov.br/siscomex/pt-br) |

**Também verificado na R3:** LC 214, arts. 31–35 (“Do Recolhimento na Liquidação Financeira (Split Payment)”), na [versão compilada](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214compilado.htm).

### 3.4 Verificações pontuais da R4

Consultadas em 28/09/2026 para os ajustes desta revisão: [Lei 10.865/2004, art. 1º](https://www.planalto.gov.br/ccivil_03/_ato2004-2006/2004/lei/l10.865.htm), que institui separadamente PIS/Pasep-Importação e Cofins-Importação; [LC 123/2006, art. 18-A](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp123.htm) e [Portal do Simples Nacional](https://www8.receita.fazenda.gov.br/SimplesNacional/Documentos/Pagina.aspx?id=4), que distinguem MEI da opção pelo Simei; [Receita Federal sobre PER/DCOMP](https://www.gov.br/receitafederal/pt-br/canais_atendimento/fale-conosco/perdcomp), que o identifica como pedido ou declaração; [MOC NF-e](https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=LrBx7WT9PuA%3D), que identifica NFA-e como NF-e modelo 55 emitida por sistema da administração; e [Receita Federal sobre DIRF](https://www.gov.br/receitafederal/pt-br/canais_atendimento/fale-conosco/suporte-a-dirf), que confirma substituição para fatos do ano-calendário 2025 em diante. Estas conferências são pontuais: **não** validam as demais chaves de §3.3 nem toda a vigência das 630 propostas.

## 4. Dicionário — tributos e espécies (`tax_species`, `tax`)

**Universo:** competências e espécies constitucionalmente enumeradas são estruturalmente delimitáveis, mas tributos instituídos, modalidades, alterações e tributos históricos exigem revisão temporal e por ente. `tax_species` não é tributo cobrado; `tax` identifica tributo específico ou família jurídica explicitamente marcada. `IRPF/IRPJ` são modalidades do imposto sobre renda, não novas competências constitucionais. `IRRF` é retenção, não tributo diferente. Tributo previsto ≠ instituído ≠ exigível em cada período. Fontes CF, CTN, LC214, LC116; `H` para o recorte funcional.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `tax_species.tax` | Imposto | Espécie não vinculada a atividade estatal específica; + imposto de renda; − taxa de polícia. | CF/CTN·H | Espécie, não lançamento concreto. |
| `tax_species.fee` | Taxa | Espécie por poder de polícia ou serviço público específico e divisível; + taxa de fiscalização; − tarifa contratual. | CF/CTN·H | Não confundir taxa com preço público. |
| `tax_species.improvement_contribution` | Contribuição de melhoria | Espécie ligada a obra pública e valorização imobiliária; + contribuição por obra pública nos termos legais; − CIDE. | CF/CTN·H | Instituição local a verificar. |
| `tax_species.special_contribution` | Contribuição especial | Família constitucional de contribuições sociais, interventivas, corporativas e outras previstas; + contribuição social; − imposto. | CF·H | Não supor igual base/competência entre subfamílias. |
| `tax_species.compulsory_loan` | Empréstimo compulsório | Espécie de competência da União nas hipóteses do art. 148; + lei complementar por calamidade nos termos constitucionais; − empréstimo bancário. | CF·H | Previsão não prova instituição atual. |
| `tax.ir` | Imposto sobre a renda | Imposto federal sobre renda/proventos; + norma de IR; − CSLL. | CF/CTN·H | rel: `tax.irpf`, `.irpj` como modalidades; retenção (IRRF) é tema `theme.withholding`, não tributo nem tratamento próprio. |
| `tax.irpf` | IRPF | Modalidade de IR da pessoa física; + tabela do IRPF; − lucro real de PJ. | CF/CTN·H | rel: modalidade de `tax.ir`, sem nova competência. |
| `tax.irpj` | IRPJ | Modalidade de IR da pessoa jurídica; + apuração de IRPJ; − CSLL. | CF/CTN·H | rel: modalidade de `tax.ir`. |
| `tax.icms` | ICMS | Imposto estadual/DF sobre circulação de mercadorias e prestações constitucionalmente descritas; + ICMS da venda; − ISS de serviço da LC 116. | CF·H | Transição futura não apaga normas históricas. |
| `tax.iss` | ISS | Imposto municipal/DF sobre serviços definidos na LC 116 e lei competente; + norma local de ISS; − qualquer serviço sem hipótese comprovada. | CF/LC116·H | Existe sem conector municipal; ente/lei local separados. |
| `tax.ipi` | IPI | Imposto federal sobre produtos industrializados; + alíquota de IPI; − ICMS do produto. | CF·H | Produção de efeitos na reforma por dispositivo. |
| `tax.pis_pasep` | PIS/Pasep | Contribuição ligada aos programas PIS/Pasep e suas incidências legais; + regra de PIS/Pasep; − CBS. | CF·H | Não reduzir todas incidências a faturamento. |
| `tax.cofins` | Cofins | Contribuição para financiamento da seguridade social; + crédito de Cofins; − CSLL. | CF·H | Regras cumulativas/não cumulativas são regimes, não novos tributos; códigos de regime ainda ausentes (G17). |
| `tax.ibs` | IBS | Imposto sobre Bens e Serviços da competência compartilhada constitucional; + regra de apuração do IBS; − ICMS. | CF/LC214·H | Instituído; aplicabilidade/efeitos dependem de data e dispositivo. |
| `tax.cbs` | CBS | Contribuição Social sobre Bens e Serviços; + crédito de CBS; − PIS/Cofins. | CF/LC214·H | Transição e produção de efeitos qualificadas. |
| `tax.is` | Imposto Seletivo | Imposto federal seletivo previsto no art. 153, VIII e instituído na LC 214; + hipótese de IS; − IPI. | CF/LC214·H | Não inferir aplicação a todo produto nocivo. |
| `tax.csll` | CSLL | Contribuição social sobre lucro líquido; + base de CSLL; − IRPJ. | CF·H | Pode coexistir com IRPJ, sem equivalência. |
| `tax.iof` | IOF | Imposto federal sobre operações de crédito, câmbio, seguro e títulos/valores mobiliários; + IOF-câmbio; − tarifa bancária. | CF·H | Modalidades não criam espécie nova. |
| `tax.ii` | Imposto de Importação | Imposto federal sobre importação de produtos estrangeiros; + alíquota do II; − ICMS-importação. | CF·H | Operação `importation` é separada. |
| `tax.ie` | Imposto de Exportação | Imposto federal sobre exportação de produtos nacionais/nacionalizados; + alíquota do IE; − benefício a exportador. | CF·H | Não confundir com operação de exportação. Sigla “IE” colide com Inscrição Estadual: alias bloqueado sem contexto (§15). |
| `tax.itr` | ITR | Imposto federal sobre propriedade territorial rural; + declaração de ITR; − atividade de produtor rural. | CF·H | Sujeito e propriedade não são segmento. |
| `tax.ipva` | IPVA | Imposto estadual/DF sobre propriedade de veículos automotores; + norma de IPVA; − IPI de veículo. | CF·H | Escopo/efeitos da redação constitucional por data. |
| `tax.itcmd` | ITCMD | Imposto estadual/DF sobre transmissão causa mortis e doação; + doação tributada; − ITBI oneroso. | CF·H | Variação lexical ITCD requer jurisdição. |
| `tax.iptu` | IPTU | Imposto municipal sobre propriedade predial e territorial urbana; + IPTU de imóvel; − ITR. | CF·H | Não deduzir área urbana só por CEP. |
| `tax.itbi` | ITBI | Imposto municipal sobre transmissão onerosa inter vivos de imóveis/direitos previstos; + ITBI na compra de imóvel; − ITCMD. | CF·H | Titularidade/direito e exceções exigem prova. |
| `tax.social_security_contribution` | Contribuições previdenciárias | Família de contribuições sociais destinadas à previdência; + contribuição patronal previdenciária; − IRRF sobre salário. | CF·H | Família ampla; RGPS/RPPS e bases exigem especialização futura. |
| `tax.cide` | CIDE | Família das contribuições de intervenção no domínio econômico; + Cide-Combustíveis; − contribuição previdenciária. | CF·H | Nome de família, não uma exação universal. |
| `tax.cide_fuels` | Cide-Combustíveis | Contribuição interventiva ligada a combustíveis na legislação própria; + norma da Cide-Combustíveis; − IBS-combustíveis. | CF/L10336·H | pai: `tax.cide` somente como subfamília funcional. |
| `tax.corporate_interest_contribution` | Contribuições de interesse de categorias | Contribuições do art. 149 para categorias profissionais/econômicas; + contribuição de conselho competente; − mensalidade voluntária. | CF·H | Família; espécies concretas por conselho/lei pendentes. |
| `tax.cip` | Contribuição para iluminação pública | Contribuição municipal/DF do art. 149-A, cuja redação atual contempla finalidades ali previstas; + lei municipal de CIP; − tarifa de energia. | CF·H | COSIP/CIP dependem de uso local; conferir edição histórica. |
| `tax.rpps_contribution` | Contribuição ao RPPS | Contribuição de servidores/aposentados/pensionistas ao regime próprio conforme art. 149 §1º; + contribuição de servidor ao RPPS; − contribuição RGPS de empregado. | CF·H | rel: `tax.social_security_contribution`; ente instituidor variável. |
| `tax.igf` | Imposto sobre grandes fortunas | Competência constitucional federal sujeita a lei complementar; + proposta normativa de IGF; − IR sobre patrimônio. | CF·H | **Apenas previsto constitucionalmente**; não afirmar exigibilidade/instituição. |
| `tax.residual_tax` | Imposto residual | Competência federal condicionada do art. 154, I; + lei complementar que institua imposto residual; − novo nome para ICMS. | CF·H | Conceito de competência; não tributo concreto. |
| `tax.extraordinary_war_tax` | Imposto extraordinário de guerra | Competência federal excepcional do art. 154, II; + instituição formal em guerra/iminência; − adicional comum. | CF·H | Conceito de competência, não exigível por mera previsão. |
| `tax.pis_pasep_import` | PIS/Pasep-Importação | Contribuição incidente na importação de bens ou serviços nas hipóteses da Lei 10.865; + alíquota do PIS/Pasep-Importação; − alíquota da Cofins-Importação. | CF/L10865·H | rel: `tax.pis_pasep`; exação distinta da Cofins-Importação; efeitos de transição por dispositivo. |
| `tax.cofins_import` | Cofins-Importação | Contribuição incidente na importação de bens ou serviços nas hipóteses da Lei 10.865; + alíquota da Cofins-Importação; − alíquota do PIS/Pasep-Importação. | CF/L10865·H | rel: `tax.cofins`; exação distinta do PIS/Pasep-Importação; efeitos de transição por dispositivo. |
| `tax.payroll_employer_contribution` | Contribuição patronal sobre folha | Contribuição previdenciária da empresa sobre remunerações pagas, nos termos da lei de custeio; + alíquota patronal sobre folha; − contribuição descontada do empregado. | CF/L8212·H | pai: `tax.social_security_contribution`. |
| `tax.rat` | RAT/GILRAT | Contribuição para benefícios por incapacidade decorrente dos riscos ambientais do trabalho; + alíquota RAT ajustada pelo FAP; − seguro privado de acidentes. | CF/L8212·H | pai: `tax.social_security_contribution`; FAP é multiplicador, não tributo. |
| `tax.cprb` | CPRB | Contribuição previdenciária sobre receita bruta em substituição total ou parcial à contribuição patronal sobre folha, nas atividades legais; + regra de desoneração da folha; − contribuição sobre folha. | L12546/L14973·H | pai: `tax.social_security_contribution`; substituição parcial decrescente em 2025–2027 (art. 9-A da Lei 12.546, incluído pela Lei 14.973/2024, verificado na R3). |
| `tax.rural_commercialization_contribution` | Contribuição sobre a comercialização da produção rural | Contribuição previdenciária do produtor rural e da agroindústria sobre a receita da comercialização da produção, nas hipóteses legais; + alíquota sobre venda de produção rural; − ITR. | CF/L8212·H | pai: `tax.social_security_contribution`; “Funrural” é alias popular (§15); sujeito, opção pela folha e sub-rogação exigem prova. |
| `tax.salary_education` | Salário-educação | Contribuição social destinada à educação básica, devida pelas empresas sobre a folha; + alíquota do salário-educação; − mensalidade escolar. | CF·H | CF art. 212, §5º; lei de regência a registrar na TAX-03. |
| `tax.third_party_contributions` | Contribuições a terceiros (Sistema S e outras) | Família de contribuições sobre folha destinadas a entidades de serviço social e formação profissional e a outras destinações legais; + contribuição ao Senai; − doação voluntária. | CF·H | CF art. 240; entidades (Sesi, Senai, Sesc, Senac, Sebrae, Senar, Sest, Senat, Incra etc.) como subtipos futuros; alíquota não inferida por segmento. |
| `tax.cide_royalties` | Cide-Royalties/Remessas | Cide sobre remessas ao exterior por royalties, assistência técnica e serviços nas hipóteses legais; + Cide sobre royalties de tecnologia; − IRRF sobre a mesma remessa. | CF/L10168·H | pai: `tax.cide`; pode coexistir com IRRF, sem equivalência. |
| `tax.afrmm` | AFRMM | Adicional ao Frete para Renovação da Marinha Mercante sobre frete aquaviário nas hipóteses legais; + AFRMM na importação por navio; − frete rodoviário. | CF/L10893·H | rel: `tax.cide`; natureza jurídica a confirmar na TAX-03. |
| `tax.condecine` | Condecine | Contribuição para o desenvolvimento da indústria cinematográfica nacional; + Condecine sobre obra audiovisual; − ISS de exibição. | CF/MP2228·H | rel: `tax.cide`; natureza e hipóteses a confirmar. |
| `tax.fust` | Fust | Contribuição ao Fundo de Universalização dos Serviços de Telecomunicações sobre receita de prestadores; + alíquota do Fust; − ICMS-comunicação. | CF/L9998·H | rel: `tax.cide`; natureza a confirmar; segmento telecom não prova contribuinte. |
| `tax.funttel` | Funttel | Contribuição ao Fundo para o Desenvolvimento Tecnológico das Telecomunicações; + contribuição ao Funttel; − Fust. | CF/L10052·H | rel: `tax.fust` só como vizinhança. |
| `tax.state_primary_products_contribution` | Contribuição estadual sobre produtos primários e semielaborados | Contribuição que Estados com fundos existentes em 30/04/2023, financiados por contribuições exigidas como condição de tratamento de ICMS, podem instituir de forma semelhante e não vinculada ao ICMS; + contribuição a fundo estadual de infraestrutura; − ICMS da operação. | CF·H | ADCT art. 136 (EC 132/2023), consulta pendente; prazo final e ente por dispositivo; não inferir para UF sem lei própria. |

**Históricos e lacunas:** `CPMF` é candidato histórico, não entrará como tributo corrente sem período e base revisados. Contribuições sociais específicas (inclusive salário-educação, terceiros e contribuições de seguridade por base), novas competências ou alterações de 2026 e exações estaduais/municipais específicas exigem inventário jurídico independente. TAX-03 deve confrontar a lista com todos os dispositivos constitucionais relevantes e nomenclaturas oficiais; contagem acima não prova completude.

## 5. Dicionário — temas (`theme`) e tratamentos (`treatment`)

**Universo:** aberto, sem catálogo oficial exaustivo; fonte funcional TriBusca ancorada em CF/CTN/LC214 e leis específicas. Tema identifica o assunto; tratamento identifica o mecanismo efetivamente descrito, condicionado por tributo, operação, sujeito, território e tempo. As linhas seguintes são `T` ou `H` conforme âncora. “Obrigação principal/acessória” como *tema* não substitui uma obrigação concreta da dimensão `obligation`.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `theme.tax_incidence` | Incidência | Discussão sobre hipótese em que tributo alcança fato; + regra de incidência de ICMS; − mero nome do produto. | CTN·H | Exige hipótese e tributo para afirmação concreta. |
| `theme.non_incidence` | Não incidência | Discussão de fato fora da hipótese tributária; + norma de não incidência; − isenção. | CF/CTN·H | Distinguir imunidade/isenção. |
| `theme.immunity` | Imunidade | Limitação constitucional de competência de tributar; + imunidade prevista na CF; − redução legal de alíquota. | CF·H | Não equivaler a isenção. |
| `theme.exemption` | Isenção | Dispensa legal do tributo nas condições do ato; + isenção legal; − imunidade constitucional. | CTN·H | Vínculo com `treatment.exemption` só com regra concreta. |
| `theme.tax_suspension` | Suspensão | Discussão de suspensão de exigibilidade, incidência ou recolhimento, conforme contexto; + suspensão de exigibilidade; − revogação de ato. | CTN·H | **Ambíguo:** objeto da suspensão obrigatório. rel: `treatment.tax_suspension`. |
| `theme.tax_deferral` | Diferimento | Discussão da postergação de momento de exigência/recolhimento em regra tributária; + diferimento do ICMS; − prorrogação de prazo de entrega de EFD. | RICMS-MT-ANEXO-VII-R5/TriBusca·H | rel: `treatment.tax_deferral`; sem regra automática. |
| `theme.tax_substitution` | Substituição tributária | Discussão de atribuição legal de recolhimento a substituto; + ST de ICMS; − substituição de documento. | CTN-R5/RICMS-MT-ST-R6/TriBusca·H | rel: `treatment.tax_substitution`. |
| `theme.anticipation` | Antecipação | Discussão de exigência/recolhimento antecipado; + antecipação de ICMS; − prazo futuro de vigência. | TriBusca/NEEDS_EVIDENCE·H | Não presumir ST. |
| `theme.assessed_tax_credit` | Crédito tributário (CTN) | Assunto relativo ao crédito constituído/exigível na relação Fisco-sujeito passivo; + constituição de crédito por lançamento; − crédito de entrada na apuração. | CTN·H | Sentido jurídico diferente de `theme.input_credit`. |
| `theme.input_credit` | Crédito de entrada | Apropriação de crédito ligado a aquisição/insumo conforme tributo; + crédito de entrada de ICMS; − crédito tributário lançado pela Fazenda. | NEEDS_EVIDENCE·H | Não inferir direito ao crédito só da compra. |
| `theme.presumed_credit` | Crédito presumido | Discussão de crédito atribuído legalmente por presunção/fórmula; + concessão de crédito presumido; − “crédito” isolado. | RICMS-MT-ANEXO-VI-R5/TriBusca·H | rel: `theme.tax_benefit`; sem hierarquia automática. |
| `theme.credit_reversal` | Estorno de crédito | Discussão de reversão de crédito antes apropriado; + estorno obrigatório; − ressarcimento. | NEEDS_EVIDENCE·H | Crédito/tributo devem ser especificados. |
| `theme.credit_maintenance` | Manutenção de crédito | Discussão de conservação de crédito em operação que de outro modo o afetaria; + manutenção expressa; − simples apuração. | NEEDS_EVIDENCE·H | Dependência da norma. |
| `theme.credit_appropriation` | Apropriação de crédito | Registro/uso de crédito admissível; + prazo de apropriação; − restituição em dinheiro. | NEEDS_EVIDENCE·H | Não validar elegibilidade automaticamente. |
| `theme.reimbursement` | Ressarcimento | Recuperação de valor/crédito na modalidade legal específica; + pedido de ressarcimento; − estorno. | CTN/NEEDS_EVIDENCE·H | Diferenciar restituição por base legal. |
| `theme.refund` | Restituição | Devolução de tributo pago indevidamente ou a maior, quando cabível; + restituição de pagamento indevido; − crédito presumido. | CTN·H | Não inferir deferimento do pedido. |
| `theme.offset` | Compensação | Uso de crédito para quitar débito conforme lei; + compensação tributária; − reembolso em dinheiro. | CTN·H | Condições e tributos elegíveis. |
| `theme.tax_benefit` | Benefício fiscal | Assunto de favorecimento fiscal juridicamente identificado; + norma concede incentivo fiscal; − mera menção a setor. | CF/NEEDS_EVIDENCE·H | Não assumir que todo crédito presumido é seu subtipo. |
| `theme.tax_base_reduction` | Redução de base de cálculo | Discussão de diminuição da base tributável; + base reduzida a percentual; − alíquota reduzida. | NEEDS_EVIDENCE·H | rel: `treatment.tax_base_reduction`. |
| `theme.rate_reduction` | Redução de alíquota | Discussão de diminuição da alíquota; + alíquota reduzida; − base reduzida. | NEEDS_EVIDENCE·H | rel: `treatment.rate_reduction`. |
| `theme.tax_rate` | Alíquota | Discussão da medida percentual/específica aplicável; + fixa alíquota de ICMS; − preço da mercadoria. | CTN/NEEDS_EVIDENCE·H | Valor numérico é atributo da regra. |
| `theme.tax_base` | Base de cálculo | Discussão da grandeza sobre a qual incide alíquota; + altera base do IPI; − valor de multa. | CTN·H | Valor e composição são fatos estruturados. |
| `theme.additional_rate` | Adicional | Parcela adicional legal sobre tributo/base; + adicional de IR; − juros de mora. | NEEDS_EVIDENCE·H | Exigir tributo e fundamento. |
| `theme.withholding` | Retenção | Discussão de desconto/recolhimento na fonte por responsável; + IRRF; − não pagamento. | CTN/NEEDS_EVIDENCE·H | `IRRF` não vira tributo novo. |
| `theme.payment` | Recolhimento | Discussão de pagamento/forma de recolher; + prazo de recolhimento; − emissão de NF-e. | CTN·H | Prazo como atributo. |
| `theme.assessment` | Lançamento | Discussão da constituição do crédito nos termos do CTN; + lançamento de ofício; − escrituração contábil. | CTN·H | Ambiguidade lexical com lançamento contábil. |
| `theme.audit` | Fiscalização | Atuação de verificação tributária; + procedimento fiscal; − revisão interna voluntária. | CTN·H | Não implica autuação. |
| `theme.penalty` | Penalidade | Sanção tributária prevista; + multa por descumprimento; − alíquota do tributo. | CTN·H | `theme.fine` é espécie de penalidade. |
| `theme.fine` | Multa | Penalidade pecuniária; + multa de mora; − juros ou tributo principal. | CTN·H | pai: `theme.penalty`; tipo/montante como atributo. |
| `theme.installment_plan` | Parcelamento | Divisão legal de débito em parcelas; + programa de parcelamento; − diferimento de ICMS da operação. | CTN·H | Condições variam por programa. |
| `theme.main_obligation` | Obrigação principal | Prestação de pagar tributo/penalidade nas condições legais; + dever de pagar imposto; − entregar EFD. | CTN·H | Assunto jurídico, não `obligation.*`. |
| `theme.ancillary_obligation` | Obrigação acessória | Dever instrumental de fazer/não fazer tributário; + entregar escrituração; − pagar ICMS. | CTN·H | `obligation.efd_icms_ipi` é instância específica. |
| `theme.non_cumulativity` | Não cumulatividade | Técnica constitucional/legal de abatimento de créditos; + regra de não cumulatividade; − regime monofásico presumido pela palavra “crédito”. | L10637/L10833/LC214-R5·H | Aplicação depende de tributo e período. |
| `theme.rate_difference` | Diferencial de alíquotas | Assunto de diferença entre alíquotas interna/destino e interestadual quando a norma assim o define; + regra de DIFAL do ICMS; − qualquer mudança de alíquota. | CF/LC190·H | Tributo, operação e sujeito são necessários; não é alias de `theme.tax_rate`. DIFAL a contribuinte (uso/consumo, ativo) é anterior à LC 190 e se ancora na CF. |
| `theme.tax_dispute` | Contencioso tributário | Discussão administrativa/judicial de exigência; + impugnação fiscal; − simples consulta de alíquota. | CTN/NEEDS_EVIDENCE·H | Processo e fase como atributos. |
| `theme.split_payment` | Recolhimento na liquidação financeira (split payment) | Segregação e recolhimento de IBS/CBS no momento da liquidação financeira da operação, pelo procedimento padrão ou simplificado; + regra do procedimento padrão; − boleto comum sem regra de segregação. | LC214·H | LC 214, arts. 31–35 (verificado na R3); aplicação por cronograma/regulamento; não é `theme.withholding`. |
| `theme.personalized_refund` | Devolução personalizada (cashback) | Devolução de IBS/CBS a pessoas físicas de baixa renda nas condições legais; + regra de devolução a família cadastrada; − cashback comercial de varejo. | CF/LC214·H | “cashback” comercial é homônimo (§15). |
| `theme.reform_transition` | Transição da reforma tributária | Regras de convivência e substituição progressiva entre ICMS, ISS, PIS, Cofins e IPI e os novos IBS, CBS e IS; + alíquota-teste de IBS/CBS; − alteração de ICMS sem relação com a transição. | CF/LC214·H | ADCT (EC 132/2023) e LC 214 por período; datas são fatos temporais (§14), não o tema. |
| `theme.national_basic_basket` | Cesta Básica Nacional de Alimentos | Conjunto legal de alimentos com alíquota zero de IBS/CBS; + inclusão de produto na cesta nacional; − cesta básica estadual de ICMS. | CF/LC214·H | rel: `treatment.zero_rate`; lista e NCM do anexo por edição. |
| `theme.benefit_compensation_fund` | Compensação de benefícios fiscais do ICMS | Mecanismo constitucional de compensação a titulares de benefícios onerosos de ICMS durante a transição; + regra de habilitação ao fundo; − concessão de novo benefício de ICMS. | CF·H | ADCT (EC 132/2023) e lei de regência; não prova direito de cliente. |
| `theme.assisted_assessment` | Apuração assistida | Apuração de IBS/CBS apoiada em informações pré-apuradas pelas administrações tributárias; + regra de apuração assistida; − escrituração contábil própria. | LC214·H | Dispositivos a conferir na TAX-03. |
| `theme.transfer_pricing` | Preços de transferência | Regras de ajuste de transações controladas entre partes relacionadas; + norma de preços de transferência; − preço de venda interna comum. | L14596·H | Partes relacionadas e transação controlada por prova. |
| `theme.tax_settlement` | Transação tributária | Acordo com a Fazenda para encerrar litígio ou regularizar dívida nas condições legais; + edital de transação; − parcelamento ordinário. | CTN/L13988·H | rel: `theme.installment_plan`, `theme.tax_dispute`. |
| `theme.tax_consultation` | Consulta tributária formal | Procedimento de consulta à administração sobre interpretação da legislação; + solução de consulta publicada; − dúvida em fórum privado. | NEEDS_EVIDENCE·H | rel: `event.clarifies`; efeito vinculante por ente. |

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `treatment.exemption` | Isenção aplicada | Regra concreta que dispensa tributo em hipótese definida; + “fica isenta a operação X”; − texto apenas menciona isenção. | CTN·H | rel: `theme.exemption`; condições obrigatórias. |
| `treatment.tax_deferral` | Diferimento aplicado | Deslocamento normativo do momento de exigência/recolhimento; + “fica diferido ICMS até a saída”; − adiamento da vigência do decreto. | RICMS-MT-ANEXO-VII-R5/TriBusca·H | rel: `theme.tax_deferral`. |
| `treatment.tax_substitution` | Substituição tributária aplicada | Regra atribui responsabilidade de recolher a substituto; + fabricante recolhe ICMS-ST; − empresa troca fornecedor. | CTN/NEEDS_EVIDENCE·H | Não inferir sujeito substituto sem texto. |
| `treatment.monophase` | Incidência monofásica | Técnica de concentrar tributação em etapa determinada; + regra monofásica expressa; − qualquer venda de combustível. | NEEDS_EVIDENCE·H | Tributo/etapa/tempo necessários. |
| `treatment.tax_suspension` | Suspensão tributária aplicada | Regra suspende exigibilidade/incidência/recolhimento, qualificada pelo objeto; + suspensão expressa de cobrança; − publicação suspensa. | CTN/NEEDS_EVIDENCE·H | rel: `theme.tax_suspension`. Não unificar suspensão de crédito com alíquota zero. |
| `treatment.presumed_credit` | Crédito presumido concedido | Regra concede crédito calculado por presunção/fórmula; + concessão expressa; − simples “crédito” sem qualificador. | RICMS-MT-ANEXO-VI-R5/TriBusca·H | rel: `theme.presumed_credit`. |
| `treatment.tax_base_reduction` | Base reduzida aplicada | Regra reduz base em hipótese definida; + “base reduzida em 30%”; − redução da alíquota. | NEEDS_EVIDENCE·H | Valor é atributo, não conceito. |
| `treatment.rate_reduction` | Alíquota reduzida aplicada | Regra reduz alíquota em hipótese definida; + taxa de 5% em vez da ordinária; − isenção total presumida. | NEEDS_EVIDENCE·H | Variação temporal. |
| `treatment.zero_rate` | Alíquota zero | Alíquota legalmente fixada em zero em hipótese; + “alíquota zero”; − imunidade. | LC214-R5/TriBusca·H | Não equiparar a isenção. |
| `treatment.anticipation` | Antecipação aplicada | Regra concreta que exige recolhimento antes da etapa usual; + “recolhimento antecipado na entrada no Estado”; − prazo antecipado de entrega de declaração. | NEEDS_EVIDENCE·H | rel: `theme.anticipation`; não presumir ST. |
| `treatment.credit_reversal` | Estorno de crédito aplicado | Regra que determina anular crédito apropriado em hipótese definida; + estorno proporcional à saída isenta; − ressarcimento. | NEEDS_EVIDENCE·H | rel: `theme.credit_reversal`. |
| `treatment.credit_maintenance` | Manutenção de crédito aplicada | Regra que autoriza manter crédito apesar de saída desonerada; + manutenção expressa na exportação; − simples apropriação. | NEEDS_EVIDENCE·H | rel: `theme.credit_maintenance`. |

## 6. Dicionário — regimes (`regime`)

**Universo:** aberto/temporal; denominação legal ou funcional com prova. Regime não é tema genérico nem direito individual adquirido. Lucro Real/Presumido/Arbitrado são formas de tributação de renda/lucro, não tributos. Regime especial pode depender de ato individual, que não será globalizado.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `regime.simples_nacional` | Simples Nacional | Regime especial unificado da LC 123; + alteração de anexo do Simples; − empresa pequena sem opção comprovada. | LC123·H | Enquadramento individual é privado. |
| `regime.actual_profit` | Lucro Real | Forma legal de determinação de lucro tributável; + apuração do lucro real; − balanço societário isolado. | RIR·H | Não é tributo. |
| `regime.presumed_profit` | Lucro Presumido | Forma legal de determinação presumida de lucro; + percentual de presunção do IRPJ; − crédito presumido de ICMS. | RIR·H | Alias “presumido” isolado é ambíguo. |
| `regime.arbitrated_profit` | Lucro Arbitrado | Forma legal de determinação arbitrada do lucro; + hipótese de arbitramento; − estimativa interna de empresa. | RIR·H | Exigir base normativa. |
| `regime.regular` | Regime regular/normal | Regime ordinário **do tributo identificado** em oposição a regime especial; + regime regular do IBS; − “normal” sem tributo. | LC214/NEEDS_EVIDENCE·H | Código genérico exige qualificador de tributo; TAX-03 audita utilidade. |
| `regime.special` | Regime especial | Conjunto excepcional de regras criado/autorizado por ato; + regime especial de apuração; − benefício isolado. | NEEDS_EVIDENCE·H | Nome guarda-chuva; não inferir concessão a empresa. |
| `regime.differentiated_ibs_cbs` | Regime diferenciado IBS/CBS | Família legal de regras diferenciadas para IBS/CBS; + capítulo da LC 214 sobre regime diferenciado; − benefício de ICMS histórico. | LC214·H | Famílias/subtipos em TAX-03. |
| `regime.specific_ibs_cbs` | Regime específico IBS/CBS | Família legal de regimes específicos do IBS/CBS; + regime específico de combustíveis; − monofásico de PIS sem IBS/CBS. | LC214·H | Não atribuir a todo combustível sem hipótese. |
| `regime.customs_transit` | Trânsito aduaneiro | Regime aduaneiro de trânsito sob controle competente; + norma de trânsito aduaneiro; − frete doméstico. | ADUANA·H | Base/edição normativa específica para TAX-03. |
| `regime.temporary_admission` | Admissão temporária | Regime aduaneiro de entrada temporária nas condições legais; + admissão temporária de equipamento; − importação definitiva. | ADUANA·H | Modalidades e efeitos não inferidos. |
| `regime.drawback` | Drawback | Regime aduaneiro especial ligado a exportação, conforme modalidade; + ato de drawback; − qualquer exportação. | ADUANA·H | Modalidades/edições na TAX-03. |
| `regime.pis_cofins_cumulative` | PIS/Cofins cumulativo | Regime de apuração de PIS/Cofins sem créditos, nas hipóteses legais; + empresa do lucro presumido no regime cumulativo; − crédito de insumo. | L9718·H | Por tributo e período; substituição pela CBS por dispositivo. |
| `regime.pis_cofins_non_cumulative` | PIS/Cofins não cumulativo | Regime de apuração de PIS/Cofins com créditos, nas hipóteses legais; + crédito de insumos de PIS/Cofins; − lucro real presumido pela palavra “crédito”. | L10637/L10833·H | rel: `theme.non_cumulativity`. |
| `regime.simei` | Simei | Sistema de recolhimento em valores fixos mensais dos tributos abrangidos pelo Simples Nacional para MEI optante; + regra de opção pelo Simei; − condição de MEI sem referência à opção/recolhimento. | LC123/CGSN·H | pai: `regime.simples_nacional` (LC 123, art. 18-A); rel: `subject.mei`, sem propagação. |
| `regime.zfm` | Zona Franca de Manaus | Área de livre comércio com tratamento tributário próprio constitucionalmente mantido; + benefício de IPI/IBS/CBS na ZFM; − qualquer venda para a Região Norte. | CF/DL288/LC214·H | Território e produto por ato; ADCT arts. 40 e 92-A. |
| `regime.free_trade_areas` | Áreas de livre comércio | Áreas com tratamento tributário próprio definidas em lei; + ALC de Tabatinga; − ZFM. | NEEDS_EVIDENCE/LC214·H | rel: `regime.zfm`; área por ato. |
| `regime.reidi` | Reidi | Regime especial de incentivos para infraestrutura com suspensão de PIS/Cofins nas hipóteses legais; + habilitação ao Reidi; − obra sem projeto aprovado. | L11488·H | Habilitação individual é privada; transição para CBS por dispositivo. |
| `regime.repetro` | Repetro | Regime aduaneiro especial para bens de pesquisa e lavra de petróleo e gás; + admissão no Repetro-Sped; − compra de combustível. | ADUANA·H | Modalidades e edição normativa na TAX-03. |
| `regime.recof` | Recof | Regime aduaneiro de entreposto industrial sob controle informatizado; + habilitação ao Recof; − drawback. | ADUANA·H | Modalidades na TAX-03. |

**Não viram códigos de regime na v1:** substituição tributária, diferimento, suspensão e monofásico são `treatment.*` quando aplicados, ainda que um ato os chame de “regime”; a linguagem do ato fica registrada como menção. Um regime complexo que os contenha pode ser futuro conceito próprio, após definição e evidência.

## 7. Dicionário — operações e facetas (`operation`, `operation_scope`, `operation_purpose`, `operation_channel`)

**Universo:** aberto, vocabulário funcional TriBusca, condicionado por CF/CTN, documentos, NBS e legislação de cada tributo. Ação/negócio (`operation.*`), âmbito (`operation_scope.*`), finalidade/destinação (`operation_purpose.*`) e canal (`operation_channel.*`) são eixos separados. Natureza da circulação, titularidade, origem/destino, modalidade contratual, fase, prazo e partes são atributos ou relações quando necessário. A menção a uma operação não prova incidência, benefício, CFOP, NBS nem que um cliente a pratica. A [NBS 2.0](https://www.gov.br/mdic/pt-br/assuntos/sdic/comercio-e-servicos/nbs-nomenclatura-brasileira-de-servicos) é referência externa para serviços, não equivalência automática; o [MOC NF-e](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-anexo-i-leiaute-e-rv.pdf) usa CFOP como código fiscal do documento, não como identidade canônica de toda operação econômica. `fiscal_code.cfop_reference` é tipo de vínculo oficial proposto (`O`): positivo CFOP explicitamente informado em documento da edição identificada; negativo atribuir CFOP a “venda” genérica sem contexto. Seu vínculo guarda órgão, tabela/edição, perspectiva de entrada/saída, vigência, código e prova; **zero códigos CFOP** foram importados.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `operation.purchase` | Compra/aquisição onerosa | Aquisição de bem/direito por contraprestação; + compra de insumos; − bonificação gratuita. | TriBusca·T | Não inferir crédito fiscal. |
| `operation.sale` | Venda | Alienação onerosa de bem/mercadoria; + venda de soja; − remessa para demonstração. | TriBusca·T | Âmbito separado. |
| `operation.resale` | Revenda | Venda de item adquirido para comércio, sem transformação essencial; + revenda de mercadoria; − fabricação e venda própria. | TriBusca·T | pai: `operation.sale` apenas no sentido funcional, sem herança fiscal. |
| `operation.transfer` | Transferência | Movimentação entre estabelecimentos/titulares conforme contexto sem pressupor venda; + transferência entre filiais; − venda a terceiro. | TriBusca·T | Titularidade obrigatória para efeitos. |
| `operation.shipment` | Remessa | Envio físico/documental com finalidade declarada; + remessa para industrialização; − venda inferida. | TriBusca·T | Finalidade em atributo. |
| `operation.return` | Retorno | Volta de bem remetido para finalidade anterior; + retorno de demonstração; − devolução de compra por desfazimento. | TriBusca·T | Vínculo à remessa original. |
| `operation.devolution` | Devolução | Desfazimento total/parcial de operação anterior com retorno/devolução; + devolução de compra; − retorno normal de comodato. | TriBusca·T | Operação original vinculada. |
| `operation.bonus` | Bonificação | Entrega sem preço próprio como bonificação comercial; + mercadoria em bonificação; − desconto financeiro. | TriBusca·T | Tributação não inferida. |
| `operation.manufacture` | Industrialização | Transformação/beneficiamento industrial; + industrialização de grão; − armazenagem sem transformação. | TriBusca·T | Pode ser processo, não circulação. |
| `operation.contract_manufacture` | Industrialização por encomenda | Industrialização realizada por terceiro sob encomenda; + remessa a industrializador; − fabricação própria. | TriBusca·T | rel: `operation.manufacture`; exige partes. |
| `operation.importation` | Importação | Entrada de mercadoria/serviço do exterior no contexto da norma; + importação de máquina; − compra interestadual. | L10865/SISCOMEX-R5·H | Bem/serviço e etapa aduaneira separados. |
| `operation.exportation` | Exportação | Saída de bem/serviço para exterior conforme hipótese; + exportação de milho; − venda interna a exportadora. | SISCOMEX-R5·H | Não inferir benefício. |
| `operation.service_provision` | Prestação de serviço | Realização de serviço a tomador; + prestação de software descrita; − venda de equipamento. | LC116/TriBusca·H | ISS/IBS conforme lei e período, sem inferência automática. |
| `operation.transport_service` | Prestação de transporte | Serviço de transporte sob contrato, qualquer objeto ou modal, quando o ato não especifica; + “prestação de serviço de transporte” genérica; − deslocamento interno próprio. | CF/NEEDS_EVIDENCE·H | pai: `operation.service_provision` funcional. Filhos candidatos: `operation.cargo_transport`, `.passenger_transport`, `.value_transport` (TAX-03). |
| `operation.storage_service` | Armazenagem | Guarda de bens para terceiro como serviço; + armazenagem frigorificada contratada; − câmara fria própria. | TriBusca·T | Não equiparar a frigorífico de abate. |
| `operation.consignment` | Consignação | Entrega de bens para venda/uso sob relação consignatória; + mercadoria em consignação; − venda definitiva. | TriBusca·T | Contrato/etapa a verificar. |
| `operation.loan_for_use` | Comodato | Cessão gratuita temporária de uso com devolução; + equipamento em comodato; − locação onerosa. | TriBusca·T | Propriedade não muda por padrão. |
| `operation.barter` | Barter agrocomercial | Arranjo comercial do agro que combina entrega/compromisso de produção e contraprestação em insumos/financiamento conforme contrato; + grãos por insumos em barter expresso; − permuta simples de imóveis. | TriBusca·T | rel: `operation.exchange`; estrutura e etapas exigem prova, sem alias exato. |
| `operation.sale_on_order` | Venda à ordem | Operação triangular com adquirente originário, vendedor remetente e destinatário conforme norma; + venda à ordem expressa; − toda triangulação. | TriBusca·T | Partes/fluxos obrigatórios. |
| `operation.future_delivery_sale` | Venda para entrega futura | Venda com entrega física posterior; + contrato de venda para entrega futura; − mero prazo de pagamento. | TriBusca·T | Datas distintas. |
| `operation.financial_transaction` | Operação financeira | Família de negócios de crédito/câmbio/seguro/título quando o ato não especifica subtipo; + norma fala genericamente de operações financeiras; − venda de mercadoria. | CF/TriBusca·H | Preferir filho específico com prova; não atribuir IOF pelo guarda-chuva. |
| `operation.energy_supply` | Fornecimento de energia | Entrega/fornecimento de energia no escopo normativo; + regra de fornecimento de energia elétrica; − venda de gerador. | CF/TriBusca·H | Qualificar mercado/contrato futuramente. |
| `operation_scope.internal` | Âmbito interno | Origem e destino na mesma UF/ente conforme hipótese; + venda GO→GO; − GO→SP. | IBGE/TriBusca·H | Não é operação. |
| `operation_scope.interstate` | Âmbito interestadual | Origem e destino em UFs diferentes; + venda GO→SP; − GO→GO. | IBGE/TriBusca·H | Não inferir ICMS. |
| `operation_scope.international` | Âmbito internacional | Relação com exterior; + exportação Brasil→exterior; − transporte entre UFs. | IBGE/TriBusca·H | Importação/exportação ainda são operações distintas. |

### 7.1 Circulação, alienação, uso e organização empresarial

As linhas abaixo ampliam a ação econômica representável. Um fato pode ter mais de uma etapa; `operation.sale` não é sinônimo de entrega, faturamento ou pagamento. Operações patrimoniais e societárias só são classificadas quando aparecem no ato; efeitos tributários dependem da norma aplicável.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `operation.donation` | Doação | Transferência gratuita de bem/direito por liberalidade; + doação de mercadorias; − bonificação comercial presumida. | CF/CTN/TriBusca·H | Doador, donatário e objeto; ITCMD não automático. |
| `operation.exchange` | Permuta | Troca de bens/direitos sem presumir preço monetário; + imóvel por imóvel; − compra paga em dinheiro. | TriBusca·T | rel: `operation.barter`, não alias exato de contratos agro complexos. |
| `operation.free_sample_dispatch` | Remessa de amostra grátis | Envio de amostra sem preço próprio, em contexto promocional; + amostra gratuita enviada; − venda de lote. | DF-e/TriBusca·H | Finalidade amostra + remessa; TAX-03 testa se manter como padrão composto. |
| `operation.gift_promotion` | Brinde promocional | Entrega de bem como brinde vinculado à promoção; + brinde entregue ao público; − devolução de venda. | DF-e/TriBusca·H | Não confundir doação, bonificação ou amostra. |
| `operation.auction_sale` | Alienação em leilão | Venda de bem por procedimento de leilão; + leilão de veículo; − venda direta comum. | TriBusca·T | Canal/procedimento pode virar faceta na TAX-03. |
| `operation.installment_sale` | Venda a prazo | Venda cujo preço será pago em parcelas; + venda com parcelas; − parcelamento de tributo. | TriBusca·T | Pagamento é atributo contratual; candidato a padrão composto. |
| `operation.real_estate_sale` | Alienação onerosa de imóvel | Transferência onerosa de imóvel/direito nas condições do ato; + venda de terreno; − locação do terreno. | CF/TriBusca·H | ITBI/IR/IBS não inferidos. |
| `operation.real_estate_development` | Incorporação imobiliária | Promoção/estruturação de empreendimento imobiliário para alienação; + incorporação de edifício; − incorporação societária. | TriBusca·T | Homonímia; atos/contratos por etapa. |
| `operation.asset_disposal` | Alienação de ativo | Venda/transferência onerosa de bem do ativo; + venda de máquina usada do imobilizado; − compra de estoque. | TriBusca·T | Finalidade/origem do ativo deve ser provada. |
| `operation.asset_lease` | Locação de bem móvel | Cessão temporária onerosa do uso de bem móvel; + locação de máquina; − comodato gratuito. | TriBusca/LC116·H | Serviço associado e incidência não presumidos. |
| `operation.real_estate_lease` | Locação de imóvel | Cessão temporária onerosa de imóvel; + aluguel de loja; − venda de imóvel. | TriBusca·T | Objeto e remuneração explícitos. |
| `operation.financial_lease` | Arrendamento mercantil | Cessão de uso sob contrato de leasing, conforme modalidade; + arrendamento mercantil de equipamento; − locação simples. | TriBusca/NEEDS_EVIDENCE·H | Modalidade financeira/operacional; revisão jurídica TAX-03. |
| `operation.loan_of_fungibles` | Mútuo | Empréstimo de bem fungível com restituição equivalente; + mútuo de dinheiro; − comodato de máquina. | CC/TriBusca·H | Não inferir IOF sem hipótese. Sobrepõe `operation.loan_granting` quando o bem é dinheiro; TAX-03 decide fusão ou hierarquia. |
| `operation.rights_assignment` | Cessão de direitos | Transferência de posição/direito descrito; + cessão de crédito contratual; − prestação de serviço sem cessão. | TriBusca·T | Tipo de direito e contraprestação. |
| `operation.capital_contribution` | Integralização de capital | Entrega de dinheiro/bem/direito para compor capital; + integralização com imóvel; − venda comum do imóvel. | CF/TriBusca·H | Condições de imunidade/tributação não automáticas. |
| `operation.profit_distribution` | Distribuição de lucros | Transferência de lucros/dividendos a sócio/acionista; + distribuição de dividendos; − pagamento de salário. | RIR/TriBusca·H | Regime e data importam. |
| `operation.corporate_fusion` | Fusão societária | União de sociedades para formar sociedade nova; + fusão de duas empresas em nova pessoa; − incorporação de uma pela outra. | LSA/TriBusca·H | LSA art. 228; código distingue consolidação contábil. |
| `operation.corporate_absorption` | Incorporação societária | Absorção de uma ou mais sociedades por outra; + incorporação de subsidiária por controladora; − constituição simples de empresa ou incorporação imobiliária. | LSA/TriBusca·H | LSA art. 227; não confundir com constituição de pessoa jurídica. |
| `operation.corporate_spin_off` | Cisão societária | Transferência de parcelas patrimoniais em reorganização; + cisão parcial; − venda isolada de ativo. | LSA/TriBusca·H | Parcial/total como atributo (LSA art. 229). |
| `operation.inheritance_transfer` | Transmissão causa mortis | Transferência patrimonial por falecimento; + transmissão hereditária; − doação em vida. | CF/TriBusca·H | Sujeitos/objeto/jurisdição; ITCMD não inferido. |

### 7.2 Produção, transformação e ciclo físico de bens

Industrialização é família de processo, mas abate, beneficiamento, montagem e reciclagem exigem distinções funcionais. A etapa de produção não é automaticamente operação tributável; remessa ao terceiro e retorno são ações separadas.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `operation.agricultural_cultivation` | Cultivo agrícola | Produção vegetal por cultivo; + plantio/cultivo de soja; − mera compra de soja. | TriBusca/CNAE·H | Atividade econômica da empresa não inferida. |
| `operation.harvest` | Colheita | Retirada de produto cultivado; + colheita de milho; − venda posterior. | TriBusca·T | Pode ser própria ou serviço contratado. |
| `operation.livestock_raising` | Criação de animais | Produção pecuária por criação; + criação de bovinos; − abate por frigorífico. | TriBusca/CNAE·H | Espécie/finalidade. |
| `operation.slaughter` | Abate | Sacrifício/processamento inicial de animal; + abate bovino; − armazenagem de carne. | TriBusca/CNAE·H | Atividade/segmento frigorífico não automático. |
| `operation.extraction` | Extração | Retirada de recurso natural; + extração de minério; − fabricação de aço. | TriBusca/CNAE·H | Recurso e método; setor não inferido. |
| `operation.refining` | Refino | Processamento para purificação/separação de insumo; + refino de petróleo; − revenda de diesel. | TriBusca·T | Produto/etapa explícitos. |
| `operation.beneficiation` | Beneficiamento | Tratamento físico/industrial que melhora ou prepara bem; + beneficiamento de grão; − armazenagem sem tratamento. | TriBusca·T | rel: `operation.manufacture`, efeitos legais contextuais. |
| `operation.assembly` | Montagem | União de componentes em bem montado; + montagem de equipamento; − instalação posterior no cliente. | TriBusca·T | Pode ser industrialização conforme lei, sem inferência automática. |
| `operation.packaging` | Acondicionamento | Colocação de produto em embalagem comercial; + envase em garrafas; − transporte de produto já embalado. | TriBusca·T | Efeitos no IPI dependem de regra. |
| `operation.repackaging` | Reacondicionamento | Alteração de embalagem/apresentação de bem; + reenvasar em embalagem de venda; − troca de caixa de transporte sem finalidade comercial. | TriBusca·T | Distinção legal de acondicionamento a revisar. |
| `operation.blending` | Mistura/formulação | Combinação de materiais para novo produto/formulação; + mistura de biodiesel; − estoque conjunto sem mistura. | TriBusca·T | Composição final relevante. |
| `operation.repair` | Conserto/reparo | Correção de defeito em bem; + conserto de motor; − manutenção preventiva sem defeito. | NBS/TriBusca·H | Serviço, peças e remessa separados. |
| `operation.maintenance` | Manutenção | Atividade de preservação/funcionamento de bem; + manutenção periódica de máquina; − venda de peça sem serviço. | NBS/TriBusca·H | Preventiva/corretiva como atributo. |
| `operation.installation` | Instalação | Montagem/colocação de equipamento em funcionamento/local; + instalação de turbina; − venda isolada de turbina. | NBS/TriBusca·H | Contrato e obra podem mudar enquadramento. |
| `operation.recycling` | Reciclagem | Transformação de resíduo em material reutilizável; + reciclagem de plástico; − descarte simples. | TriBusca·T | Produto/resíduo e etapa. |
| `operation.waste_treatment` | Tratamento de resíduos | Processamento de resíduos para redução/gestão de riscos; + tratamento de resíduos industriais; − mera coleta. | NBS/TriBusca·H | Serviço vs produção de material reciclado. |
| `operation.destruction` | Destruição/inutilização | Eliminação física de bem sob procedimento; + destruição de estoque avariado; − venda com desconto. | TriBusca·T | Prova e destino; baixa fiscal distinta. |
| `operation.inventory_write_off` | Baixa de estoque | Retirada contábil/fiscal de item do estoque; + baixa por perda; − devolução física ao fornecedor. | TriBusca·T | Processo contábil, não circulação; TAX-03 valida dimensão. |

### 7.3 Comércio exterior, logística e circulação documentada

Entrada/saída do país, despacho, transporte e entrega são etapas diferentes. Regime aduaneiro (`regime.*`) é condição jurídica, não sinônimo da ação realizada. [Manuais da Receita](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/manuais) e [MOC CT-e](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/a41-moc_cte_anexo-i_leiaute_e_regras_de_validacao_v4-00-anexo-vi.pdf) fornecem referências para auditoria das distinções.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `operation.temporary_importation` | Importação temporária | Entrada de bem estrangeiro com intenção juridicamente temporária; + equipamento admitido temporariamente; − importação definitiva. | ADUANA·H | rel: `regime.temporary_admission`; não equivalência. |
| `operation.temporary_exportation` | Exportação temporária | Saída de bem com intenção de retorno sob hipótese legal; + máquina enviada a reparo no exterior; − exportação definitiva. | ADUANA·H | Prazo/regime por ato. |
| `operation.reexportation` | Reexportação | Saída ao exterior de bem antes importado/admitido conforme regime; + reexportação de bem admitido; − exportação inicial de bem nacional. | ADUANA·H | Relacionar entrada anterior. |
| `operation.reimportation` | Reimportação | Reentrada de bem anteriormente exportado; + retorno de máquina exportada temporariamente; − primeira importação. | ADUANA·H | Identidade do bem/procedimento. |
| `operation.customs_clearance` | Despacho/desembaraço aduaneiro | Procedimento de apresentação/liberação perante aduana; + desembaraço de importação; − compra no exterior sem despacho comprovado. | ADUANA·H | Despacho ≠ operação comercial. |
| `operation.customs_transit` | Trânsito aduaneiro | Transporte de mercadoria sob controle aduaneiro; + carga em trânsito aduaneiro; − frete doméstico ordinário. | ADUANA·H | rel: `regime.customs_transit`. |
| `operation.bonded_storage` | Armazenagem alfandegada | Guarda de bem em recinto sob controle aduaneiro; + depósito em entreposto; − armazém privado comum. | ADUANA·H | Regime específico e local por prova. |
| `operation.cargo_transport` | Transporte de carga | Deslocamento contratado de bens/carga; + frete rodoviário de mercadoria; − deslocamento próprio sem prestação. | NBS/DF-e·H | rel: `operation.transport_service`; modal em atributo. |
| `operation.passenger_transport` | Transporte de passageiros | Deslocamento contratado de pessoas; + passagem de ônibus; − frete de carga. | NBS/DF-e·H | Modal/âmbito e BP-e distintos. |
| `operation.value_transport` | Transporte de valores | Transporte contratado de numerário/valores; + transporte de malotes de dinheiro; − depósito bancário. | NBS/DF-e·H | GTV-e não inferida sem hipótese. |
| `operation.freight_subcontracting` | Subcontratação de transporte | Contratação de outro transportador para executar prestação; + transportador subcontrata frete; − contratação inicial pelo remetente. | DF-e/TriBusca·H | Partes/prestação original necessárias. |
| `operation.multimodal_transport` | Transporte multimodal | Prestação com mais de um modal sob contrato aplicável; + transporte rodoviário e ferroviário integrado; − duas compras de frete independentes. | DF-e/NBS·H | Operador/contrato/modais. |
| `operation.cargo_transshipment` | Transbordo de carga | Transferência de carga entre veículos/meios na cadeia logística; + transbordo em terminal; − transferência de propriedade. | TriBusca·T | Não é venda. |
| `operation.delivery` | Entrega | Colocação de bem à disposição do destinatário conforme negócio; + entrega física ao adquirente; − emissão de NF-e sem entrega. | TriBusca·T | Data/local; pode diferir de venda. |
| `operation.pickup` | Coleta/retirada de mercadoria | Retirada física de bem em origem; + transportador coleta carga; − aquisição de propriedade. | TriBusca·T | Agente e local. |
| `operation.distribution` | Distribuição física | Organização/envio de bens em rede logística; + centro distribui mercadorias a lojas; − fabricação. | TriBusca·T | Pode compor diversas remessas, não prova atacado. |

### 7.4 Serviços, plataformas e direitos

A [NBS/NEBS 2.0](https://www.gov.br/mdic/pt-br/assuntos/sdic/comercio-e-servicos/nbs-nomenclatura-brasileira-de-servicos) é referência de serviços/intangíveis sob ótica de produto, mas **nenhum** código NBS é inferido destes nomes funcionais. Prestação, licenciamento, cessão e uso de plataforma são relações distintas; a lista da LC 116/2003 e legislação municipal, quando aplicáveis, são outro eixo.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `operation.software_development` | Desenvolvimento de software | Criação/customização de software sob contrato; + desenvolvimento sob encomenda; − revenda de computador. | NBS/LC116·H | Entrega/licença e prestação por contrato. |
| `operation.software_licensing` | Licenciamento de software | Concessão de direito de uso de software; + licença de uso de aplicativo; − venda de servidor físico. | NBS/LC116·H | Modelo contratual, prazo e titularidade. |
| `operation.saas_provision` | Prestação SaaS | Disponibilização contínua de software como serviço; + assinatura de plataforma SaaS; − licença perpétua isolada. | NBS/TriBusca·H | Não equiparar automaticamente a licenciamento. |
| `operation.cloud_hosting` | Hospedagem em nuvem | Disponibilização de infraestrutura/ambiente de computação hospedado; + hospedagem de servidor virtual; − compra de servidor físico. | NBS/TriBusca·H | IaaS/PaaS/SaaS como subtipos futuros, se provados. |
| `operation.data_processing` | Processamento de dados | Tratamento computacional contratado de dados; + processamento de folha por terceiro; − mera venda de mídia. | NBS/TriBusca·H | Dados de cliente privados não integram conceito. |
| `operation.telecommunication_service` | Serviço de telecomunicação | Prestação de transmissão/comunicação a usuário; + serviço móvel contratado; − venda de telefone. | CF/NBS·H | ICMS/ISS/IBS conforme ato e período. |
| `operation.advertising_service` | Publicidade | Criação/veiculação publicitária conforme contrato; + serviço de campanha; − venda de cartaz sem serviço. | NBS/LC116·H | Criação e veiculação podem divergir. |
| `operation.commercial_intermediation` | Intermediação comercial | Aproximação de partes para negócio por terceiro; + comissão por intermediar venda; − venda própria de mercadoria. | NBS/LC116·H | Plataforma/mandato e responsabilidade por tributo separadas. |
| `operation.marketplace_intermediation` | Intermediação por marketplace | Intermediação de negócios em plataforma de múltiplos vendedores; + comissão da plataforma; − e-commerce próprio. | NBS/TriBusca·H | rel: `operation.commercial_intermediation`; dados de vendedor privados. |
| `operation.professional_consulting` | Consultoria profissional | Prestação de aconselhamento técnico/profissional; + consultoria contábil; − venda de apostila. | NBS/LC116·H | Profissão e objeto podem especializar. |
| `operation.education_service` | Serviço educacional | Ensino/treinamento prestado a aluno/tomador; + curso escolar; − venda de livro. | NBS/LC116·H | Imunidade/benefício não presumido. |
| `operation.healthcare_service` | Serviço de saúde | Atendimento/tratamento clínico por prestador; + consulta médica; − venda de medicamento. | NBS/LC116·H | Especialidade/prestador e lei local. |
| `operation.construction_service` | Execução de obra | Execução contratada de obra de construção; + construção de edifício por empreitada; − venda isolada de cimento. | NBS/LC116·H | Material, subempreitada, local e modalidade. |
| `operation.engineering_service` | Serviço de engenharia | Elaboração/assistência técnica de engenharia; + projeto estrutural; − construção executada sem projeto contratado. | NBS/LC116·H | Pode coexistir com obra, não equivalente. |
| `operation.cleaning_service` | Serviço de limpeza | Limpeza contratada de local/bem; + limpeza predial; − venda de detergente. | NBS/LC116·H | Equipe/local/contrato. |
| `operation.security_service` | Serviço de vigilância | Proteção/vigilância contratada; + vigilância patrimonial; − venda de câmera. | NBS/LC116·H | Regulação específica. |
| `operation.hospitality_service` | Hospedagem | Acomodação temporária remunerada; + diária de hotel; − locação residencial comum. | NBS/LC116·H | Componentes e contrato. Homonímia com `operation.cloud_hosting`. |
| `operation.event_service` | Organização de eventos | Planejamento/execução de evento para terceiro; + organização de congresso; − venda de ingresso isolada. | NBS/LC116·H | Partes e serviços agregados. |

### 7.5 Operações financeiras, de seguro e pagamento

Uma norma pode tratar fluxo financeiro sem que o ato nomeie tributo ou banco específico. “Crédito” continua polissêmico: empréstimo/financiamento é operação; crédito tributário e crédito de entrada são `theme.*`. Financiamento não prova IOF; distribuição de dividendos não prova retenção. Referência CF/CTN/RIR e NBS; a correspondência oficial de cada serviço financeiro permanece pendente.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `operation.loan_granting` | Concessão de empréstimo | Disponibilização de valor mediante obrigação de restituição; + banco concede empréstimo; − doação de dinheiro. | CF/NBS·H | Contrato, credor/devedor e modalidade. |
| `operation.loan_repayment` | Amortização de empréstimo | Devolução de principal de dívida de empréstimo; + paga parcela de principal; − pagamento de juros isolado. | NBS/TriBusca·H | Relação com contrato original. |
| `operation.interest_payment` | Pagamento de juros | Pagamento de remuneração financeira por capital/dívida; + juros de empréstimo pagos; − amortização do principal. | RIR/TriBusca·H | Fonte, período e retenção por lei. |
| `operation.currency_exchange` | Câmbio | Troca/conversão contratada de moedas; + compra de moeda estrangeira; − compra de mercadoria importada sem operação cambial provada. | CF/NBS·H | IOF e modalidade não inferidos. |
| `operation.insurance_contracting` | Contratação de seguro | Formação de contrato de cobertura securitária; + contratação de apólice; − compra de automóvel segurável. | CF/NBS·H | Prêmio e indenização são fluxos distintos. |
| `operation.insurance_premium_payment` | Pagamento de prêmio de seguro | Pagamento da contraprestação securitária; + prêmio de apólice pago; − indenização recebida. | NBS/TriBusca·H | Não inferir incidência/retenção. |
| `operation.insurance_indemnity` | Indenização securitária | Pagamento por sinistro coberto; + seguradora indeniza sinistro; − prêmio do segurado. | NBS/TriBusca·H | Contrato/sinistro e natureza do valor. |
| `operation.securities_issue` | Emissão de valor mobiliário | Criação/colocação de título ou valor mobiliário; + emissão de debêntures; − negociação secundária. | CF/TriBusca·H | Tipo de título/ente regulador. |
| `operation.securities_trade` | Negociação de valor mobiliário | Compra/venda de título em mercado; + venda de ações; − emissão primária de ações. | CF/NBS·H | Mercado e sujeito. |
| `operation.investment_redemption` | Resgate de investimento | Conversão/retirada de investimento conforme contrato; + resgate de cota de fundo; − compra inicial de cota. | RIR/TriBusca·H | Produto financeiro e rendimento separados. |
| `operation.financial_intermediation` | Intermediação financeira | Aproximação/captação e aplicação financeira por intermediário; + serviço bancário de intermediação; − empréstimo informal isolado. | NBS/TriBusca·H | Tipo de instituição e autorização não inferidos. |
| `operation.receivables_assignment` | Cessão de recebíveis | Transferência de direitos de receber valores; + cessão de duplicatas; − pagamento normal de fatura. | NBS/TriBusca·H | rel: `operation.rights_assignment`; factoring não automático. |
| `operation.factoring` | Fomento mercantil | Aquisição/gestão de recebíveis em contrato de factoring; + factoring expresso; − qualquer empréstimo bancário. | NBS/TriBusca·H | Estrutura contratual e serviços associados. |
| `operation.payment_processing` | Processamento de pagamentos | Execução/intermediação tecnológica de pagamento; + arranjo de cartão processa transação; − venda de produto pelo lojista. | NBS/TriBusca·H | Prestador/arranjo; não confundir pagamento da compra. |
| `operation.funds_transfer` | Transferência de recursos | Movimentação de dinheiro entre contas/pessoas; + transferência bancária; − transferência física de estoque. | NBS/TriBusca·H | Motivo jurídico do pagamento separado. |

### 7.6 Facetas adicionais que evitam combinações artificiais

Estas linhas não são ações por si. Elas qualificam uma ou várias operações **somente** quando o texto provar a característica. `operation_purpose` pode depender de estabelecimento concreto e então permanecer privado/indeterminado na classificação global.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `operation_purpose.resale` | Destinação à revenda | Bem adquirido para revenda; + compra de mercadoria para comercialização; − compra para consumo próprio. | TriBusca·T | Não é `operation.resale` até ocorrer venda. |
| `operation_purpose.production_input` | Destinação a insumo | Bem adquirido para integrar/ser consumido na produção; + compra de matéria-prima; − compra de máquina para ativo. | TriBusca·T | Critério tributário de “insumo” não inferido. |
| `operation_purpose.industrialization` | Finalidade industrialização | Envio/recebimento vinculado a industrialização; + remessa para industrialização; − remessa para demonstração. | TriBusca·T | Combinar com remessa/retorno/processo. |
| `operation_purpose.repair` | Finalidade conserto | Envio de bem para reparo e retorno esperado; + remessa para conserto; − venda definitiva. | TriBusca·T | Combinar com `operation.shipment` e `operation.repair`. |
| `operation_purpose.storage` | Finalidade armazenagem | Envio para guarda temporária; + remessa a armazém; − venda ao armazém. | TriBusca·T | Guarda pode ser serviço separado. |
| `operation_purpose.temporary_use` | Finalidade uso temporário | Cessão/remessa para uso limitado com retorno; + envio em comodato; − venda final. | TriBusca·T | Contrato/retorno necessários. |
| `operation_purpose.export` | Destinação à exportação | Bem ou serviço dirigido a exportação futura; + remessa com fim específico de exportação; − exportação já comprovada. | TriBusca·T | Não classificar `operation.exportation` apenas por intenção. |
| `operation_channel.marketplace` | Canal marketplace | Negócio realizado em plataforma com múltiplos ofertantes; + venda por marketplace; − venda no site próprio sem intermediação. | TriBusca·T | `operation.marketplace_intermediation` só para o serviço da plataforma. |
| `operation_channel.in_person` | Canal presencial | Negócio contratado presencialmente; + venda em loja física; − NF-e emitida após compra on-line. | TriBusca·T | Não muda operação principal. |
| `operation_purpose.demonstration` | Finalidade de demonstração | Finalidade de envio/uso para apresentação ou teste; + remessa para demonstração; − venda final. | TriBusca·T | Combinar com `operation.shipment`; não é ação isolada. |
| `operation_purpose.fixed_asset` | Destinação ao ativo imobilizado | Finalidade de integrar imobilizado, a combinar com aquisição ou transferência; + máquina comprada para ativo; − mercadoria para revenda. | TriBusca·T | Não comprova crédito fiscal. |
| `operation_purpose.own_use` | Destinação a uso/consumo | Finalidade de utilização/consumo próprio; + material de escritório comprado para uso; − insumo produtivo comprovado. | TriBusca·T | Exige contexto do estabelecimento. |
| `operation_channel.digital` | Canal digital | Venda/prestação contratada em canal digital; + venda pela plataforma on-line; − negócio físico com nota eletrônica. | TriBusca·T | Canal não é operação nem segmento automaticamente. |


**Triangulação** é candidata de estrutura de partes/fluxos, não alias exato de venda à ordem. “Aquisição interestadual para ativo” = `operation.purchase` + `operation_scope.interstate` + `operation_purpose.fixed_asset`; “venda on-line interestadual” = `operation.sale` + `operation_scope.interstate` + `operation_channel.digital`. Essas facetas evitam dezenas de combinações artificiais.

### 7.7 Ampliação R2 — ações multissetoriais

Estas operações são conceitos funcionais `proposed`, não hipóteses de incidência. A âncora `TriBusca·T` indica definição curatorial; o confronto com NBS, CFOP e legislação específica, quando necessário, pertence à TAX-03. Etapa, finalidade, âmbito, objeto, titularidade e sujeito continuam afirmações separadas. Um exemplo positivo comprova o sentido lexical da operação, não sua consequência tributária.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `operation.reverse_logistics` | Logística reversa | Fluxo organizado de recolhimento de bens pós-venda/consumo; + coleta para retorno ao fabricante; − entrega inicial ao comprador. | TriBusca·T | Não pressupõe devolução fiscal da venda. |
| `operation.warranty_replacement` | Substituição em garantia | Troca de bem defeituoso em cumprimento de garantia; + envio de peça substituta em garantia; − nova venda ordinária. | TriBusca·T | Ligar bem original, partes e remessas; não inferir CFOP. |
| `operation.product_recall` | Recolhimento de produto | Retirada de produto do mercado por convocação ou determinação; + recall de lote; − devolução individual sem campanha. | TriBusca·T | Pode compor logística reversa; sem hierarquia automática. |
| `operation.stock_loss` | Perda física de estoque | Diminuição por perecimento, furto ou sinistro documentado; + perda de mercadoria em incêndio; − baixa contábil sem perda física. | TriBusca·T | Distinguir de `operation.inventory_write_off`; causa e prova. |
| `operation.scrap_sale` | Venda de sucata | Alienação onerosa de resíduo/sucata; + venda de sucata metálica; − descarte gratuito. | TriBusca·T | rel: `operation.sale`; produto/composição separados. |
| `operation.waste_collection` | Coleta de resíduos | Serviço de retirada de resíduos para transporte/tratamento; + coleta contratada de resíduos; − venda de sucata. | TriBusca·T | Etapa distinta de tratamento/destinação. |
| `operation.final_disposal` | Destinação final de resíduos | Encaminhamento ou execução de disposição final comprovada; + disposição em aterro autorizado; − mera coleta. | TriBusca·T | Condições ambientais não inferidas. |
| `operation.grain_drying` | Secagem de grãos | Redução de umidade de grão por processo identificado; + secagem de milho recebido; − simples estocagem. | TriBusca·T | Pode ser serviço ou etapa própria; titularidade separada. |
| `operation.grain_cleaning` | Limpeza/classificação de grãos | Separação de impurezas ou graduação comercial do grão; + classificação física de soja; − transformação em óleo. | TriBusca·T | Não atribuir NCM novo sem prova. |
| `operation.seed_treatment` | Tratamento de sementes | Aplicação técnica em sementes antes do plantio; + semente tratada sob contrato; − pulverização de lavoura. | TriBusca·T | Produto e prestação separados. |
| `operation.ore_concentration` | Concentração de minério | Enriquecimento físico do teor mineral; + concentração de minério extraído; − extração sem beneficiamento. | TriBusca·T | rel: `operation.beneficiation`; processo exato a auditar. |
| `operation.steelmaking` | Produção siderúrgica | Produção de aço a partir de insumos metalúrgicos; + fabricação de aço em usina; − comércio de vergalhão. | TriBusca·T | Não é segmento nem NCM. |
| `operation.pulp_production` | Produção de celulose | Conversão industrial de matéria vegetal em polpa celulósica; + produção de celulose de madeira; − fabricação de caixa de papelão. | TriBusca·T | Produto final separado. |
| `operation.printing_service` | Serviço gráfico de impressão | Impressão realizada para terceiro sob especificação; + impressão encomendada de rótulos; − venda de impressora. | TriBusca·T | Material próprio/terceiro e produto final exigem contexto. |
| `operation.energy_generation` | Geração de energia | Produção de energia em instalação geradora; + geração elétrica fotovoltaica; − distribuição de energia adquirida. | TriBusca·T | Não confundir com `operation.energy_supply`. |
| `operation.energy_transmission` | Transmissão de energia | Transporte em rede de transmissão; + serviço de transmissão elétrica; − geração em usina. | TriBusca·T | Rede/agente/contrato exigem prova. |
| `operation.energy_distribution` | Distribuição de energia | Entrega por rede de distribuição ao mercado atendido; + distribuição elétrica por concessionária; − comércio atacadista de equipamentos. | TriBusca·T | Distinta de transmissão e fornecimento contratual. |
| `operation.energy_trading` | Comercialização de energia | Negociação contratual de energia como objeto econômico; + compra e venda de energia no mercado; − geração própria sem venda. | TriBusca·T | Não presumir ambiente livre ou regulado. |
| `operation.port_cargo_handling` | Movimentação portuária de carga | Carga, descarga ou movimentação em terminal portuário; + descarga portuária de contêiner; − frete rodoviário após porto. | TriBusca·T | Modalidade e sujeito separados. |
| `operation.cargo_consolidation` | Consolidação de carga | Agrupamento logístico de volumes para transporte; + consolidação de remessas em carga única; − fusão societária. | TriBusca·T | Operação logística, não tipo de ato societário. |
| `operation.customs_brokerage` | Despacho aduaneiro por terceiro | Serviço de representação operacional no despacho aduaneiro; + despachante contratado; − importador que atua por conta própria. | TriBusca·T | Distinguir de `operation.customs_clearance`; mandato/sujeito. |
| `operation.restaurant_service` | Fornecimento de alimentação preparada | Preparação e fornecimento de refeição ao consumidor; + refeição em restaurante; − venda de alimento embalado no atacado. | TriBusca·T | Entrega/canal e composição separados. |
| `operation.catering_service` | Fornecimento de refeições para eventos | Preparação e fornecimento contratual de refeições fora de restaurante; + buffet contratado; − locação de salão sem refeição. | TriBusca·T | Pode coexistir com serviço de evento. |
| `operation.travel_agency_service` | Agenciamento de viagem | Intermediação/organização de viagem para terceiros; + agência reserva viagem de cliente; − transporte prestado pela própria companhia. | TriBusca·T | Distinguir intermediação e prestação subjacente. |
| `operation.hospital_care` | Atendimento hospitalar | Prestação assistencial hospitalar a paciente; + internação com atendimento; − venda isolada de medicamento. | TriBusca·T | Procedimentos e pagador separados. |
| `operation.medical_diagnostics` | Serviço diagnóstico | Realização de exame ou diagnóstico em saúde; + laboratório realiza exame; − fabricação de reagente diagnóstico. | TriBusca·T | rel: `operation.healthcare_service`; sem inferir enquadramento fiscal. |
| `operation.pharmaceutical_compounding` | Manipulação farmacêutica | Preparação individualizada de produto farmacêutico segundo fórmula; + medicamento manipulado; − revenda de caixa industrializada. | TriBusca·T | Produto, serviço e contrato exigem análise do ato. |
| `operation.water_supply` | Abastecimento de água | Fornecimento de água por sistema de abastecimento; + distribuição de água tratada; − venda de água engarrafada. | TriBusca·T | Regime público/privado como atributo. |
| `operation.sewage_service` | Coleta/tratamento de esgoto | Serviço de coleta e/ou tratamento de esgoto; + tratamento em estação; − fornecimento de água isolado. | TriBusca·T | Etapas podem exigir subtipos. |
| `operation.intellectual_property_license` | Licença de propriedade intelectual | Autorização contratual de uso de direito imaterial; + licença de marca; − venda definitiva de máquina. | TriBusca·T | Tipo de direito, prazo e território separados; software tem código próprio. |
| `operation.royalty_payment` | Pagamento de royalties | Pagamento pelo uso/exploração de direito pactuado; + royalty de marca pago; − preço de mercadoria. | TriBusca·T | Não inferir IRRF/CIDE sem hipótese. |
| `operation.real_estate_brokerage` | Corretagem imobiliária | Intermediação de negócio imobiliário; + comissão por venda de imóvel intermediada; − alienação própria do imóvel. | TriBusca·T | Distinta de `operation.real_estate_sale`. |
| `operation.property_management` | Administração imobiliária | Gestão contratada de imóvel de terceiro; + administração de locação por imobiliária; − locação do próprio imóvel. | TriBusca·T | Comissão, aluguel e proprietário separados. |
| `operation.reinsurance_contracting` | Contratação de resseguro | Transferência contratual de risco de seguradora a ressegurador; + contrato de resseguro; − seguro primário do consumidor. | LC126/TriBusca·H | Não tratar como alias de seguro. |
| `operation.pension_contribution` | Aporte previdenciário complementar | Pagamento a plano previdenciário complementar; + contribuição a plano fechado; − folha salarial ordinária. | LC109/TriBusca·H | Previdência pública não inferida. |
| `operation.pension_benefit_payment` | Pagamento de benefício previdenciário complementar | Prestação paga por plano complementar ao beneficiário; + renda de previdência privada; − resgate de aplicação bancária. | LC109/TriBusca·H | Modalidade e tributação por ato. |
| `operation.consortium_administration` | Administração de consórcio | Gestão de grupo de consórcio; + taxa de administração de consórcio; − empréstimo bancário direto. | TriBusca·T | Pagamento de bem pelo grupo é etapa distinta. |
| `operation.receivables_anticipation` | Antecipação de recebíveis | Disponibilização antecipada de valor de recebível futuro; + antecipação contratada de vendas com cartão; − pagamento normal no vencimento. | TriBusca·T | Pode sobrepor cessão/factoring; fronteira em TAX-03. |
| `operation.guarantee_granting` | Prestação de garantia | Constituição de garantia de obrigação de terceiro ou própria; + fiança contratada; − quitação da dívida. | TriBusca·T | Tipo e remuneração separados. |
| `operation.virtual_asset_custody` | Custódia de ativo virtual | Guarda/controle contratual de ativo virtual para terceiro; + custódia por prestador; − posse própria sem serviço. | L14478/TriBusca·H | Definição regulatória e objeto por edição do ato. |
| `operation.virtual_asset_exchange` | Intermediação de ativo virtual | Intermediação de troca/negociação de ativo virtual; + plataforma intermedeia troca; − mera custódia. | L14478/TriBusca·H | Não pressupor tratamento de valor mobiliário. |

## 8. Dicionário — documentos fiscais (`document`)

**Universo:** famílias/modelos oficiais podem ser enumerados por edição, mas a lista nacional completa e os documentos locais/históricos dependem de inventário. `document` não é `obligation`; leiaute e versão são metadados oficiais, não novo conceito a cada nota técnica. Na coluna `Modelo`, traço indica ausência de modelo nacional numérico único comprovado. Portais DF-e, CONFAZ e NFS-e são as âncoras; documento auxiliar impresso não é automaticamente novo DF-e.

| Código | Rótulo; modelo oficial | Definição/finalidade; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `document.nfe` | NF-e; 55 | Documento eletrônico de operações com mercadorias e demais hipóteses do modelo; + alteração do XML NF-e; − EFD ICMS/IPI. | DF-e·H | Versão do MOC/NT por edição. |
| `document.nfce` | NFC-e; 65 | Documento eletrônico voltado a operações com consumidor final conforme disciplina; + leiaute NFC-e; − NF-e 55. | DF-e·H | UF/implantação podem variar. |
| `document.nfse` | NFS-e; — | Documento eletrônico de prestação de serviços; + padrão nacional NFS-e; − NF-e mercadorias. | NFSE/LC116·H | **Padrão nacional e sistema local** qualificados; não presumir adoção municipal. |
| `document.cte` | CT-e; 57 | Conhecimento eletrônico para serviço de transporte de cargas; + leiaute CT-e 57; − MDF-e. | DF-e·H | MOC CT-e versão por edição. |
| `document.cte_os` | CT-e OS; 67 | Conhecimento eletrônico de outros serviços abrangidos pelo modelo; + regra CT-e OS 67; − CT-e de cargas 57. | DF-e·H | Não tratar todo transporte como CT-e OS. |
| `document.mdfe` | MDF-e; 58 | Manifesto eletrônico que agrupa/documenta carga e transporte nas hipóteses normativas; + evento do MDF-e; − CT-e. | DF-e·H | Não substituir conhecimento. |
| `document.bpe` | BP-e; 63 | Bilhete de passagem eletrônico nas hipóteses de transporte de passageiros; + leiaute BP-e; − CT-e OS. | DF-e·H | Modelo e edição do ajuste a conferir na TAX-03. |
| `document.gtve` | GTV-e; 64 | Guia de transporte de valores eletrônica; + leiaute GTV-e; − CT-e de carga comum. | DF-e·H | [MOC CT-e 4.00](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/a41-moc_cte_anexo-i_leiaute_e_regras_de_validacao_v4-00-anexo-vi.pdf). |
| `document.nf3e` | NF3-e; 66 | Nota fiscal eletrônica de energia elétrica; + norma de NF3-e; − fatura comercial de energia sem modelo. | DF-e·H | Confirmar ajuste/edição por ato. |
| `document.nfcom` | NFCom; 62 | Nota fiscal eletrônica de serviço de comunicação; + regra NFCom; − nota de telecom sem modelo provado. | DF-e·H | Confirmar implantação/edição. |
| `document.dere` | DeRE; — | Documento fiscal da Declaração de Regimes Específicos no modelo técnico oficial; + leiaute/evento DeRE; − NF-e de venda comum. | DERE·H | rel: `obligation.dere` por `fulfills`; não são identidade igual. |
| `document.rural_producer_invoice` | Nota Fiscal de Produtor; **modelo 04** | Documento fiscal legado modelo 04, somente quando o ato da UF e o período confirmarem sua validade; + Nota Fiscal de Produtor modelo 04 expressamente referida; − NF-e/NFP-e modelo 55 emitida por produtor. | MOC-NFE-R5/GO-NFE-R6·H | **Não** equivale automaticamente a NF-e/NFP-e. A NF-e modelo 55 pode substituir o modelo 04 conforme disciplina da UF; guardar UF, ato, edição e período. Exemplos R5: GO admite NF-e 55 em substituição ao modelo 04; MOC 7.0 preserva a distinção entre os modelos. |


**Decisão R5 — NFA-e:** `document.nfae` deixa de ser conceito canônico. O MOC NF-e 7.0 define NFA-e como **NF-e modelo 55** emitida por sistema da administração tributária e usa `serie` (B07) e `procEmi` (B26) para identificar o processo de emissão. A R5 representa isso como **fato/propriedade estruturada de `document.nfe`**, por exemplo `emission_process = nfae_fisco | nfae_contribuinte_portal_fisco`, acompanhado de série/faixa e edição do MOC/NT. Isso não cria novo modelo fiscal. Contraexemplo: NF-e 55 emitida pelo aplicativo próprio do contribuinte não recebe a classificação NFA-e apenas por ser modelo 55.

**Pendências documentais:** NF-e, NFC-e, CT-e, CT-e OS, MDF-e, BP-e, GTV-e, NF3-e, NFCom, NFS-e e DeRE são apenas núcleo v1. Conhecimento aéreo/aquaviário/ferroviário, documentos setoriais, modelos legados, DANFE/DACTE e NFS-e locais exigem inventário e distinção entre documento fiscal, documento auxiliar e representação. A referência oficial de modelos 57/67/64 consta do [MOC CT-e 4.00](https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/a41-moc_cte_anexo-i_leiaute_e_regras_de_validacao_v4-00-anexo-vi.pdf); demais modelos serão reconferidos por ajustes individuais na TAX-03 antes de qualquer catálogo implementável. A DeRE tem papéis documental e declaratório conforme [SPED](https://www.gov.br/sped/pt-br/assuntos/documentos-fiscais/dere); o vínculo não faz toda declaração virar documento fiscal.

## 9. Dicionário — obrigações, escriturações, declarações e plataformas (`obligation`, `platform`)

**Universo:** aberto e temporal, com obrigações federais, estaduais e municipais. Uma plataforma hospeda módulos; um arquivo é artefato de entrega; dever concreto de entregar depende de sujeito, período e norma. Todos os registros são classificações de assunto, não afirmação de obrigação de cliente.

| Código | Rótulo | Definição/finalidade; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `platform.sped` | SPED | Sistema Público de Escrituração Digital que abriga projetos/módulos; + norma sobre plataforma SPED; − EFD isolada como plataforma inteira. | SPED·H | `obligation.*` módulos relacionados, sem equivalência. |
| `platform.esocial` | eSocial | Sistema de escrituração digital de informações trabalhistas, previdenciárias e fiscais; + evento de eSocial; − DCTFWeb. | ESOC·H | Arquivo/evento são artefatos, não plataformas novas. |
| `obligation.efd_icms_ipi` | EFD ICMS/IPI | Escrituração fiscal digital dos registros do escopo ICMS/IPI; + alteração de registro EFD ICMS/IPI; − NF-e. | SPED·H | Não inferir ICMS e IPI em toda alteração de leiaute. |
| `obligation.efd_contributions` | EFD-Contribuições | Escrituração digital de contribuições no escopo normativo; + bloco da EFD-Contribuições; − EFD ICMS/IPI. | SPED·H | Tributos variam por período/regramento. |
| `obligation.ecd` | ECD | Escrituração Contábil Digital; + manual ECD; − ECF. | SPED·H | Não é documento fiscal. |
| `obligation.ecf` | ECF | Escrituração Contábil Fiscal; + programa ECF; − ECD. | SPED·H | Pode apoiar IRPJ/CSLL, sem inferência automática. |
| `obligation.dctfweb` | DCTFWeb | Declaração federal de débitos/créditos tributários em seu escopo temporal; + entrega DCTFWeb; − MIT tratado como declaração separada. | DCTF·H | Períodos/substituições por edição. |
| `obligation.efd_reinf` | EFD-Reinf | Escrituração fiscal digital de retenções e outras informações fiscais; + evento EFD-Reinf; − eSocial. | SPED/DCTF·H | Integração com DCTFWeb não é equivalência. |
| `obligation.esocial_events` | Eventos eSocial | Conjunto de eventos informativos exigidos conforme escopo; + envio de evento eSocial; − cadastro privado do cliente. | ESOC·H | rel: `platform.esocial`; evento específico via catálogo oficial. |
| `obligation.gia_state` | GIA estadual | Família de guia/declaração estadual de informações e apuração conforme UF; + GIA-SP expressamente citada; − EFD federal. | SEFAZSP·H | **Guarda-chuva**; não existe obrigação nacional uniforme. |
| `obligation.destda` | DeSTDA | Declaração de substituição tributária, diferencial de alíquota e antecipação do ICMS devida por optantes do Simples Nacional, conforme Ajuste SINIEF 12/2015 e atos posteriores; + norma DeSTDA; − EFD ICMS/IPI. | CONFAZ·H | Regras/obrigados dependem de período e UF. |
| `obligation.dere` | DeRE | Dever declaratório de prestar informações de regimes específicos IBS/CBS no escopo dos atos aplicáveis; + regra de entrega DeRE; − obrigação de emitir NF-e. | DERE·H | rel: `document.dere` por `fulfilled_by`; sujeitos/prazos por edição. |
| `obligation.pgdas_d` | PGDAS-D | Declaração e cálculo mensal do Simples Nacional; + regra de transmissão do PGDAS-D; − DAS pago. | LC123/CGSN·H | rel: `regime.simples_nacional`. |
| `obligation.defis` | Defis | Declaração anual de informações socioeconômicas e fiscais do Simples Nacional; + prazo da Defis; − PGDAS-D. | LC123/CGSN·H | rel: `regime.simples_nacional`. |
| `obligation.dasn_simei` | DASN-Simei | Declaração anual do microempreendedor individual; + prazo da DASN-Simei; − Defis. | LC123/CGSN·H | rel: `regime.simei`, `subject.mei`; obrigação por sujeito/período. |
| `obligation.efinanceira` | e-Financeira | Declaração de informações financeiras por instituições obrigadas; + evento da e-Financeira; − extrato ao cliente. | SPED/RFB·H | rel: `platform.sped`; obrigados por ato/edição. |
| `obligation.dimp` | DIMP | Declaração de informações de meios de pagamento às UFs; + leiaute da DIMP; − DIRBI. | CONFAZ·H | Convênio ICMS 134/2016; adesão e leiaute por UF. |
| `obligation.dmed` | DMED | Declaração de serviços médicos e de saúde à RFB; + regra de entrega da DMED; − NFS-e de consulta. | RFB·H | Obrigados por ato/edição. |
| `obligation.dimob` | DIMOB | Declaração de informações sobre atividades imobiliárias; + regra da DIMOB; − ITBI. | RFB·H | Obrigados por ato/edição. |
| `obligation.doi` | DOI | Declaração sobre operações imobiliárias prestada por serventias; + DOI de cartório; − DIMOB. | RFB·H | Sujeito é a serventia, não o comprador. |
| `obligation.dirbi` | DIRBI | Declaração eletrônica de incentivos, renúncias, benefícios e imunidades de natureza tributária; + prazo da DIRBI; − DeRE. | L14973/RFB·H | Lei 14.973/2024, art. 43 (verificado na R3); benefícios abrangidos por ato da RFB e edição. |
| `obligation.dirf` | DIRF (histórica) | Declaração do imposto retido na fonte, substituída por eventos do eSocial e da EFD-Reinf para fatos geradores desde 01/01/2025; + DIRF referente ao ano-calendário 2024; − DIRF como obrigação corrente para fatos de 2025. | RFB·H | A Receita confirma a substituição a partir do ano-calendário 2025; entregas/retificações de períodos anteriores exigem referência temporal própria. |
| `obligation.duimp` | DUIMP | Declaração Única de Importação no Portal Único Siscomex; + registro de DUIMP; − DI legada. | SISCOMEX·H | rel: `operation.customs_clearance`; convivência com DI por cronograma. |
| `obligation.due` | DU-E | Declaração Única de Exportação no Portal Único Siscomex; + registro de DU-E; − NF-e de exportação. | SISCOMEX·H | rel: `operation.exportation`. |

`PER/DCOMP` é instrumento de pedido de restituição/ressarcimento/reembolso ou declaração de compensação, conforme a [Receita Federal](https://www.gov.br/receitafederal/pt-br/canais_atendimento/fale-conosco/perdcomp). A R3 o colocava em `obligation.*`, embora não seja dever periódico imposto a todos os sujeitos. Na R4 fica como **candidato de procedimento**, sem código canônico enquanto a TAX-03 decide sua dimensão; `theme.refund` e `theme.offset` continuam representando os assuntos, e o termo pode permanecer `UNMAPPED` na dimensão de procedimento com evidência.

`MIT` consta em fonte oficial como serviço integrado à DCTFWeb e a Receita também o descreve como nova escrituração geradora da DCTFWeb. **Decisão R6:** MIT fica sem código canônico nesta revisão: não é obrigação autônoma e não será forçado em `platform`. Semanticamente, é um componente de escrituração/serviço que alimenta a DCTFWeb. A possível extensão `bookkeeping` (candidato futuro `bookkeeping.mit`) exige decisão explícita de governança sobre a TAX-01 antes da TAX-04; até lá, MIT permanece `UNMAPPED_DIMENSION`, com relação documental à `obligation.dctfweb`, sem equivalência nem propagação.

## 10. Atividade econômica, segmento e produto

### 10.1 Referências oficiais sem cópia manual

`activity.cnae_subclass_reference` é **tipo conceitual de referência**, não uma tag para toda atividade: cada vínculo externo usa CNAE-Subclasses **2.3** com seção, divisão, grupo, classe, subclasse, código oficial, descrição/notas, edição, validade e crosswalk oficial 2.2→2.3. Exemplo positivo: norma nomeia 1013-9/01 na edição aplicável; negativo: chamar uma empresa de “frigorífico” e inventar CNAE. Fonte CNAE·O, status `proposed`, definição/justificativa nesta linha, sem pai/alias. A edição 2.3 tem 1.332 subclasses segundo [IBGE](https://www.ibge.gov.br/pt/novo-portal-destaques/23506-ibge-disponibiliza-versao-2-3-das-subclasses-da-classificacao-nacional-de-atividades-economicas.html?lang=pt-BR); **zero** foram importadas aqui. O código oficial explícito pode ser classificado; uma descrição empresarial não determina CNAE automaticamente.

`commodity.ncm_reference` é tipo de referência à NCM da **edição vigente para o evento/ato**, com oito dígitos, descrição, notas de seção/capítulo, histórico/crosswalk e evidência. Positivo: ato cita código NCM preciso; negativo: “soja” sem apresentação definida. Fonte NCM·O, status `proposed`, sem pai/alias. O [procedimento da Receita](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/consultas) exige características e notas legais, portanto não há mapeamento automático produto→NCM. Descrição encontrada na norma é observação livre com proveniência, não necessariamente um conceito canônico.

### 10.2 Segmentos (`sector`)

**Universo:** aberto; vocabulário TriBusca útil ao usuário, nunca cadastro de CNAE nem prova de atividade efetiva de empresa. Segmentos podem se sobrepor e relacionar-se a CNAEs, produtos e operações com `related_to`/`maps_to_official:overlap`, **sem propagação**. `produtor rural` também é papel jurídico de sujeito; como segmento denota universo de negócios, não enquadramento legal individual.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `sector.agribusiness` | Agronegócio | Cadeia econômica ligada à produção/insumos/processamento/comércio agro; + norma fala cadeia agroindustrial; − toda empresa que compra alimento. | TriBusca·T | Guarda-chuva amplo; não pai automático de frigorífico. |
| `sector.rural_production` | Produção rural | Segmento de produção agrícola/pecuária; + política para atividade rural; − mero proprietário rural sem produção. | TriBusca·T | rel: `subject.rural_producer`. |
| `sector.meatpacking` | Frigorífico | Estabelecimento/atividade de abate e preparo primário de carnes sob cadeia frigorífica; + “frigorífico bovino” com abate; − armazém refrigerado independente. | TriBusca/CNAE·H | Definição detalhada abaixo; “abatedouro” não é alias exato. |
| `sector.slaughterhouse` | Abatedouro/matadouro | Atividade de abate, inclusive por contrato, sem pressupor processamento frigorífico integrado; + matadouro de terceiros; − distribuidor de carnes. | TriBusca/CNAE·H | rel: frigorífico, overlap possível. |
| `sector.meat_products` | Processamento de carnes | Preparo/fabricação de produtos de carne, possivelmente sem abate; + embutidos sem abate; − armazenamento de carcaça. | TriBusca/CNAE·H | rel: frigorífico, não equivalência. |
| `sector.cold_storage` | Armazenagem frigorificada | Prestação/operação de guarda refrigerada de bens; + centro de armazenagem fria; − abate bovino. | TriBusca/CNAE·H | rel: `operation.storage_service`. |
| `sector.meat_distribution` | Distribuição de carnes | Comércio/distribuição atacadista/logística de carnes; + atacadista de carnes; − processamento fabril. | TriBusca/CNAE·H | Produto carne não prova segmento. |
| `sector.food_industry` | Indústria alimentícia | Fabricação de alimentos em geral; + fabricação de massas; − supermercado que só revende. | TriBusca·T | Vários CNAEs, nenhum exato por rótulo. |
| `sector.manufacturing` | Indústria | Produção/transformação econômica ampla; + fábrica de máquinas; − comércio puro. | TriBusca·T | Amplo; relação com food_industry exige cautela. |
| `sector.wholesale` | Atacado | Comércio de bens em cadeia atacadista; + distribuidor atacadista; − varejo ao consumidor. | TriBusca·T | Modelo comercial, não operação singular. |
| `sector.retail` | Varejo | Comércio ao consumidor final predominantemente; + rede varejista; − fabricante puro. | TriBusca·T | Pode coexistir com e-commerce. |
| `sector.transport` | Transporte/logística | Serviços de transporte/logística; + transportadora rodoviária; − remetente que contrata frete. | TriBusca·T | Tipo modal e serviço qualificados. |
| `sector.fuels` | Combustíveis | Produção/distribuição/comércio de combustíveis; + distribuidora de combustível; − todo transportador consumidor de diesel. | TriBusca·T | Cadeia ampla; separar etapas. |
| `sector.energy` | Energia | Produção/transmissão/distribuição/comercialização de energia; + distribuidora elétrica; − fabricante de geladeira. | TriBusca·T | Etapas distintas em TAX-03. |
| `sector.telecom` | Telecomunicações | Prestação de serviços de comunicação/telecom; + operadora de telecom; − software SaaS qualquer. | TriBusca·T | Tributo varia conforme serviço/lei. |
| `sector.construction` | Construção civil | Obras e serviços de construção; + construtora de edifício; − venda isolada de cimento. | TriBusca·T | Produto usado não define segmento. |
| `sector.software_saas` | Software/SaaS | Desenvolvimento, licenciamento ou prestação digital de software; + plataforma SaaS; − revenda de computador. | TriBusca·T | Serviço/modelo contratual separados. |
| `sector.professional_services` | Serviços profissionais | Prestação especializada intelectual/técnica; + consultoria contábil; − comércio atacadista. | TriBusca·T | Subsetor a especializar. |
| `sector.banking` | Bancos | Intermediação financeira bancária; + instituição bancária; − fintech não bancária presumida. | TriBusca·T | Autorização efetiva fora do conceito. |
| `sector.health` | Saúde | Prestação/produção econômica ligada à saúde; + hospital; − venda genérica de alimentos. | TriBusca·T | Hospitais/fármacos são atividades distintas. |
| `sector.education` | Educação | Prestação de ensino/serviços educacionais; + escola; − software usado por escola. | TriBusca·T | Benefício tributário não se presume. |
| `sector.import_trade` | Importadores | Segmento comercial de agentes que importam habitualmente; + empresa importadora descrita como tal; − operação de importação isolada prova enquadramento permanente. | TriBusca·T | rel: `subject.importer`, sem equivalência. |
| `sector.export_trade` | Exportadores | Segmento comercial de agentes que exportam habitualmente; + empresa exportadora; − venda interna. | TriBusca·T | rel: `subject.exporter`. |
| `sector.ecommerce` | Comércio eletrônico | Canal/modelo comercial de vendas on-line; + marketplace varejista; − emissão de NF-e em loja física. | TriBusca·T | **Pode ser faceta de canal**; TAX-03 audita dimensão. |

**Frigorífico — correspondências candidatas, não automáticas.** Na CNAE-Subclasses 2.3, examinar as descrições/notas dos códigos [1011-2/01, 1011-2/02, 1011-2/03, 1011-2/04 e 1012-1/03](https://cnae.ibge.gov.br/?divisao=10&tipo=cnae&view=divisao), que nomeiam frigorífico em atividades de abate, e 1012-1/01 (abate de aves) quando a prova operacional justificar. Abate sob contrato (1011-2/05 e 1012-1/04, “Matadouro”) é candidato de `sector.slaughterhouse`, não de frigorífico. O código [1013-9/01](https://cnae.ibge.gov.br/?classe=10139&view=classe) cobre fabricação de produtos de carne sem abate integrado: relação com `sector.meat_products`, **não** equivalência exata com frigorífico. Armazenagem frigorificada, abate por contrato e comércio de carnes são vizinhos, não aliases exatos; mapeamentos concretos e vigências requerem revisão da nota explicativa da edição. Exemplo positivo “frigorífico bovino que abate e prepara carcaças”; negativo “depósito refrigerado terceirizado” ou “distribuidora que apenas compra carne”. Uma norma que diz só “estabelecimento frigorífico” autoriza no máximo o segmento funcional e eventual candidata de atividade; não inventar CNAE da empresa.

### 10.2.1 Ampliação R2 — segmentos ainda não representados

Os registros abaixo descrevem linguagem de negócio, não enquadramento cadastral, benefício ou atividade efetiva de cliente. CNAE-Subclasses 2.3 serve para propor correspondências versionadas caso a caso; nenhum código é presumido pelo rótulo do segmento. As famílias cobrem mais seções da CNAE e setores citados na LC 214, sem alegar exaustividade.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `sector.mining` | Mineração | Cadeia de extração e beneficiamento mineral; + mineradora de minério de ferro; − loja de ferramentas para mineração. | TriBusca·T | Subsetores e CNAE por atividade comprovada. |
| `sector.oil_gas` | Petróleo e gás | Exploração, produção, processamento ou cadeia própria de óleo/gás; + produtora de gás natural; − posto revendedor isolado. | TriBusca·T | rel: `sector.fuels`; etapas não equivalem. |
| `sector.chemical_industry` | Indústria química | Fabricação de substâncias/preparações químicas; + fabricante de resinas; − varejista de tinta. | TriBusca·T | Farmacêutica e fertilizantes podem se sobrepor, sem herança fiscal. |
| `sector.pharmaceutical_industry` | Indústria farmacêutica | Desenvolvimento/fabricação de medicamentos e insumos farmacêuticos; + fabricante de vacinas; − hospital que administra vacina. | TriBusca·T | Registro sanitário não inferido. |
| `sector.automotive_industry` | Indústria automotiva | Fabricação/montagem de veículos e componentes; + montadora de ônibus; − concessionária que só revende. | TriBusca·T | Produto e operação separados. |
| `sector.metallurgy` | Metalurgia e siderurgia | Produção/refino/transformação primária de metais; + usina siderúrgica; − varejo de utensílios metálicos. | TriBusca·T | Mineração e fabricação de peças são vizinhos. |
| `sector.pulp_paper` | Celulose e papel | Fabricação de celulose, papel ou seus produtos industriais; + fábrica de papel; − gráfica que só imprime. | TriBusca·T | Etapas e CNAEs candidatos distintos. |
| `sector.textiles_apparel` | Têxtil e vestuário | Fiação, tecelagem e confecção de roupas; + confecção de uniformes; − loja que apenas revende roupas. | TriBusca·T | Comércio e fabricação não são aliases. |
| `sector.insurance` | Seguros e resseguros | Oferta profissional de cobertura securitária ou resseguro; + seguradora; − corretora presumida seguradora. | TriBusca·T | Intermediação pode exigir segmento próprio. |
| `sector.real_estate` | Mercado imobiliário | Desenvolvimento, intermediação ou gestão econômica de imóveis; + incorporadora imobiliária; − imóvel próprio de empresa industrial. | TriBusca·T | Operações jurídicas imobiliárias separadas. |
| `sector.tourism_hospitality` | Turismo e hospedagem | Oferta de hospedagem, viagem ou serviços turísticos; + rede hoteleira; − transportadora de carga. | TriBusca·T | Agência, hotel e transporte são atividades distintas. |
| `sector.food_service` | Alimentação fora do lar | Preparação/fornecimento comercial de refeições; + restaurante; − indústria que vende alimento embalado ao atacado. | TriBusca·T | rel: `sector.food_industry`, sem equivalência. |
| `sector.sanitation` | Saneamento | Oferta de abastecimento, esgotamento ou gestão de resíduos; + concessionária de esgoto; − fabricante de tubulação. | TriBusca·T | Modalidade/contrato separados. |
| `sector.media_advertising` | Mídia e publicidade | Produção, veiculação ou intermediação de conteúdo/publicidade; + agência publicitária; − anunciante que compra espaço. | TriBusca·T | Agências e veículos não equivalem. |
| `sector.gaming_betting` | Apostas e loterias | Exploração econômica organizada de apostas/prognósticos quando descrita no ato; + operador de apostas identificado; − consumidor que aposta. | TriBusca·T | Autorização e regime não inferidos. |
| `sector.aviation` | Aviação | Transporte e serviços econômicos ligados a aeronaves; + companhia aérea; − empresa que compra passagem. | TriBusca·T | Carga, passageiros e manutenção são atividades distintas. |
| `sector.maritime_ports` | Portos e navegação | Operação portuária ou transporte aquaviário; + terminal portuário; − exportador que usa o porto. | TriBusca·T | Porto e armador não são sinônimos. |
| `sector.health_plans` | Planos de saúde | Operação de planos privados de assistência à saúde; + operadora de plano de saúde; − hospital que atende conveniado. | L9656/LC214·H | Regime específico de IBS/CBS por ato; distinto de `sector.health`. |
| `sector.beverages` | Bebidas | Fabricação e comércio organizado de bebidas; + cervejaria; − restaurante que vende bebida. | TriBusca·T | IS se aplica por produto e hipótese, não por segmento. |
| `sector.tobacco` | Fumo/tabaco | Cadeia de cultivo industrial e fabricação de produtos de tabaco; + fabricante de cigarros; − loja de conveniência que revende cigarros. | TriBusca·T | IS por produto e hipótese. |
| `sector.sports` | Esporte e SAF | Exploração econômica de atividade desportiva, inclusive por Sociedade Anônima do Futebol; + clube constituído como SAF; − loja de artigos esportivos. | L14193/LC214·H | Regime específico da SAF por ato. |

### 10.3 Produtos e famílias (`product`)

**Universo:** aberto; NCM é classificação de mercadorias, mas não catálogo exaustivo de nomes de produtos de mercado. A [Receita](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/ncm) organiza a NCM em 21 seções e 96 capítulos e exige regras/notas para um código de oito dígitos. As **188 entradas** de §10.3 e §10.3.1 são conceitos comerciais/familiares `H` ou `T` conforme a âncora de cada linha, **não** códigos NCM validados. A menção “soja” basta para `product.soy`, não para código NCM. Família e produto podem ter `broader_than` quando a inclusão é semântica, sem herdar tributação. Uma listagem extensa continua parcial: a dimensão cresce por evidência de normas e candidatos `UNMAPPED`, não pela criação automática de toda descrição NCM.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `product.grains` | Grãos | Família de grãos agrícolas; + norma cobre grãos; − defensivos. | TriBusca/NCM·H | Sem NCM único. |
| `product.soy` | Soja | Produto/família de soja em formas não especificadas; + “soja” na norma; − óleo vegetal sem soja comprovada. | TriBusca/NCM·H | rel: `product.grains`; grão, óleo e farelo exigem qualificador/NCM distinto. |
| `product.corn` | Milho | Produto/família de milho não especificado; + “milho”; − etanol genérico. | TriBusca/NCM·H | rel: `product.grains`; formas variadas. |
| `product.wheat` | Trigo | Produto/família trigo; + trigo em grão; − pão pronto. | TriBusca/NCM·H | rel: `product.grains`. |
| `product.seeds` | Sementes | Família de sementes para finalidade especificada; + semente para plantio; − grão para consumo sem evidência de semente. | TriBusca/NCM·H | Espécie/finalidade obrigatórias para NCM. |
| `product.fertilizers` | Fertilizantes | Família de produtos para nutrição vegetal; + adubo descrito; − defensivo fitossanitário. | TriBusca/NCM·H | Formulação importa. |
| `product.crop_protection` | Defensivos agrícolas | Família de produtos fitossanitários; + herbicida descrito; − fertilizante. | TriBusca/NCM·H | Registro/forma afetam enquadramento. |
| `product.chemicals` | Produtos químicos | Família ampla de substâncias/preparações químicas; + reagente químico; − serviço de laboratório. | TriBusca/NCM·H | Não gerar NCM genérico. |
| `product.fuels` | Combustíveis | Família de combustíveis; + diesel; − máquina a diesel. | TriBusca/NCM·H | Cadeia e composição relevantes. |
| `product.diesel` | Diesel | Combustível diesel sem especificação fina; + óleo diesel expressamente citado; − gasolina. | TriBusca/NCM·H | pai: `product.fuels`; teor/composição para NCM. |
| `product.gasoline` | Gasolina | Combustível gasolina; + gasolina automotiva; − etanol. | TriBusca/NCM·H | pai: `product.fuels`. |
| `product.meat` | Carnes | Família de carne animal; + carne bovina; − animal vivo. | TriBusca/NCM·H | Espécie, corte, conservação e preparo. |
| `product.beef` | Carne bovina | Carne proveniente de bovino; + carcaça bovina; − frango. | TriBusca/NCM·H | pai: `product.meat`; forma para NCM. |
| `product.poultry_meat` | Carne de aves | Carne de aves; + frango resfriado; − ovos. | TriBusca/NCM·H | pai: `product.meat`. |
| `product.medicines` | Medicamentos | Produtos farmacêuticos destinados a tratamento/prevenção conforme contexto; + medicamento especificado; − equipamento médico. | TriBusca/NCM·H | Registro/apresentação necessários. |
| `product.medical_devices` | Dispositivos médicos | Equipamentos/artigos médicos; + prótese descrita; − medicamento. | TriBusca/NCM·H | Categoria regulatória não equivale NCM. |
| `product.machines` | Máquinas | Família de equipamentos mecânicos/industriais; + colheitadeira; − serviço de manutenção. | TriBusca/NCM·H | Função técnica para NCM. |
| `product.vehicles` | Veículos | Família de veículos; + caminhão; − peça automotiva. | TriBusca/NCM·H | Modalidade/uso/propulsão. |
| `product.electricity` | Energia elétrica | Bem/fornecimento de energia referido em norma; + fornecimento de energia elétrica; − equipamento elétrico. | TriBusca/CF·H | Evitar NCM automático; operação/tributo por lei. |
| `product.software` | Software | Bem intangível/licença/serviço digital conforme hipótese normativa; + licença de software; − hardware. | TriBusca/LC116·H | **Não forçar NCM**; contrato e período importam. |

#### Produção agropecuária, insumos e derivados

Estas entradas representam nomes de produto ou família de produto; uma mesma mercadoria pode aparecer em mais de uma cadeia. Relação com NCM é sempre pendente de espécie, forma, composição, finalidade, edição e notas legais. `product.soy` é abrangente; óleo, farelo e semente recebem códigos próprios quando expressos, sem converter os filhos em códigos NCM.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `product.rice` | Arroz | Grão ou produto de arroz sem apresentação definida; + arroz em casca; − farinha de trigo. | TriBusca/NCM·H | Família; casca, beneficiamento e preparo exigem qualificador. |
| `product.beans` | Feijão | Grãos de feijão sem espécie/apresentação definida; + feijão carioca; − soja. | TriBusca/NCM·H | Espécie e preparo para NCM. |
| `product.sorghum` | Sorgo | Grão de sorgo ou produção dele quando expressa; + sorgo granífero; − milho. | TriBusca/NCM·H | Finalidade e apresentação pendentes. |
| `product.coffee` | Café | Produto de café em forma não especificada; + café em grão; − cacau. | TriBusca/NCM·H | Verde, torrado, solúvel são formas distintas. |
| `product.cocoa` | Cacau | Cacau como fruto/semente ou derivado não especificado; + amêndoa de cacau; − café. | TriBusca/NCM·H | Derivados requerem qualificador. |
| `product.cotton` | Algodão | Fibra/produto agrícola algodão não especificado; + algodão em pluma; − tecido acabado genérico. | TriBusca/NCM·H | Fibra, fio e tecido não equivalem. |
| `product.sugarcane` | Cana-de-açúcar | Cultura/produto cana; + cana entregue à usina; − açúcar cristal. | TriBusca/NCM·H | Derivados açúcar/etanol separados. |
| `product.soybean_meal` | Farelo de soja | Resíduo/produto da extração de óleo de soja destinado conforme norma; + farelo de soja; − soja em grão. | TriBusca/NCM·H | rel: `product.soy`; composição/forma para NCM. |
| `product.soybean_oil` | Óleo de soja | Óleo derivado da soja; + óleo de soja refinado; − óleo de milho. | TriBusca/NCM·H | rel: `product.soy`; bruto/refinado para NCM. |
| `product.soybean_seed` | Semente de soja | Soja destinada a semeadura quando comprovado; + semente certificada de soja; − soja para esmagamento. | TriBusca/NCM·H | rel: `product.soy`, `.seeds`; finalidade não inferida da espécie. |
| `product.corn_seed` | Semente de milho | Milho destinado a semeadura; + semente híbrida de milho; − milho para ração. | TriBusca/NCM·H | rel: `product.corn`, `.seeds`. |
| `product.seedlings` | Mudas | Plantas jovens para cultivo/transplante; + muda de citros; − semente seca. | TriBusca/NCM·H | Espécie/estado para NCM. |
| `product.fruit` | Frutas | Família de frutos alimentares; + laranja in natura; − hortaliça genérica. | TriBusca/NCM·H | Espécie e preparo determinam código externo. |
| `product.vegetables` | Hortaliças | Família de vegetais hortícolas; + tomate in natura; − soja em grão. | TriBusca/NCM·H | Botânica/apresentação variam. |
| `product.sugar` | Açúcar | Produto de açúcar em formas comerciais; + açúcar cristal; − cana bruta. | TriBusca/NCM·H | Origem e refinamento. |
| `product.mineral_fertilizer` | Fertilizante mineral | Produto mineral para nutrição vegetal; + adubo NPK declarado; − calcário agrícola sem qualificações. | TriBusca/NCM·H | rel: `product.fertilizers`; composição é decisiva. |
| `product.organic_fertilizer` | Fertilizante orgânico | Produto orgânico para nutrição vegetal; + composto orgânico fertilizante; − resíduo orgânico sem uso comprovado. | TriBusca/NCM·H | rel: `product.fertilizers`; formulação/registro. |
| `product.agricultural_lime` | Calcário agrícola (corretivo de solo) | Insumo para correção de solo; + calcário agrícola; − cimento. | TriBusca/NCM·H | Composição/finalidade para classificação. |
| `product.herbicide` | Herbicida | Produto destinado ao controle de plantas indesejadas; + herbicida descrito; − fertilizante. | TriBusca/NCM·H | rel: `product.crop_protection`; formulação/registro. |
| `product.insecticide` | Inseticida | Produto destinado ao controle de insetos; + inseticida agrícola; − herbicida. | TriBusca/NCM·H | Uso agrícola/doméstico e formulação. |
| `product.fungicide` | Fungicida | Produto destinado ao controle de fungos; + fungicida para lavoura; − desinfetante sem essa função. | TriBusca/NCM·H | Formulação/registro. |
| `product.animal_feed` | Ração animal | Alimento preparado para animais; + ração bovina; − soja em grão sem preparo/uso indicado. | TriBusca/NCM·H | Espécie/fórmula para NCM. |
| `product.feed_supplement` | Suplemento para alimentação animal | Complemento nutricional animal; + suplemento mineral bovino; − medicamento veterinário. | TriBusca/NCM·H | Composição/função. |
| `product.live_cattle` | Bovinos vivos | Animais bovinos vivos; + boi para abate; − carne bovina. | TriBusca/NCM·H | Destinação não muda espécie do produto. |
| `product.live_swine` | Suínos vivos | Animais suínos vivos; + leitão vivo; − carne suína. | TriBusca/NCM·H | Peso/finalidade para NCM. |
| `product.live_poultry` | Aves vivas | Aves vivas de produção/comércio; + frango vivo; − carne de aves. | TriBusca/NCM·H | Espécie/idade podem importar. |

#### Alimentos e bebidas

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `product.pork` | Carne suína | Carne proveniente de suíno; + carcaça suína; − suíno vivo. | TriBusca/NCM·H | pai: `product.meat`; conservação/corte para NCM. |
| `product.fish` | Pescados | Peixes e outros pescados alimentares; + peixe congelado; − ração de peixe. | TriBusca/NCM·H | Espécie/fresco/preparado. |
| `product.processed_meat` | Produtos de carne preparados | Carnes elaboradas/conservadas; + embutido cárneo; − carcaça fresca. | TriBusca/NCM·H | Ingredientes/processamento. |
| `product.milk` | Leite | Leite animal em forma não especificada; + leite cru; − bebida vegetal. | TriBusca/NCM·H | Gordura/tratamento/embalagem. |
| `product.dairy` | Laticínios | Família de derivados de leite; + queijo; − leite de soja. | TriBusca/NCM·H | Não é NCM único. |
| `product.cheese` | Queijo | Produto lácteo coagulado/maturado conforme descrição; + queijo muçarela; − leite fluido. | TriBusca/NCM·H | rel: `product.dairy`; variedade/composição. |
| `product.eggs` | Ovos | Ovos em forma não especificada; + ovos de galinha; − carne de aves. | TriBusca/NCM·H | Espécie/conservação/finalidade. |
| `product.wheat_flour` | Farinha de trigo | Produto moído de trigo; + farinha panificável; − trigo em grão. | TriBusca/NCM·H | rel: `product.wheat`; composição/preparo. |
| `product.bread` | Pães | Produtos de panificação do tipo pão; + pão francês; − farinha isolada. | TriBusca/NCM·H | Forma/ingredientes. |
| `product.pasta` | Massas alimentícias | Massa preparada para alimentação; + macarrão seco; − farinha de trigo. | TriBusca/NCM·H | Recheio/cozimento/composição. |
| `product.edible_oils` | Óleos comestíveis | Família de óleos para alimentação; + óleo de girassol; − lubrificante industrial. | TriBusca/NCM·H | Origem/refino; soja específica em `product.soybean_oil`. |
| `product.roasted_coffee` | Café torrado | Café submetido a torra; + café torrado e moído; − café verde. | TriBusca/NCM·H | rel: `product.coffee`; moagem/embalagem. |
| `product.chocolate` | Chocolate | Preparação alimentícia com cacau conforme descrição; + barra de chocolate; − amêndoa de cacau. | TriBusca/NCM·H | rel: `product.cocoa`; composição. |
| `product.soft_drinks` | Refrigerantes | Bebidas não alcoólicas gaseificadas do tipo refrigerante; + refrigerante de cola; − água mineral. | TriBusca/NCM·H | Formulação/adoçamento. |
| `product.bottled_water` | Água envasada | Água acondicionada para consumo; + água mineral engarrafada; − água fornecida por rede. | TriBusca/NCM·H | Mineral/natural/preparada. |
| `product.beer` | Cerveja | Bebida cerveja; + cerveja enlatada; − refrigerante. | TriBusca/NCM·H | Teor alcoólico/composição. |
| `product.wine` | Vinho | Bebida vinho de uva; + vinho tinto; − cerveja. | TriBusca/NCM·H | Tipo/teor para NCM. |
| `product.spirits` | Destilados | Bebidas alcoólicas destiladas; + cachaça; − etanol combustível. | TriBusca/NCM·H | Tipo/teor. |

#### Combustíveis, energia e insumos industriais

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `product.crude_oil` | Petróleo bruto | Mistura petrolífera extraída sem refino; + óleo cru; − diesel refinado. | TriBusca/NCM·H | Estado/composição. |
| `product.natural_gas` | Gás natural | Gás de origem natural em forma não especificada; + gás natural comercializado; − GLP. | TriBusca/NCM·H | Canal/estado físico para NCM. |
| `product.lng` | Gás natural liquefeito | Gás natural liquefeito; + GNL descrito; − GLP. | TriBusca/NCM·H | rel: `product.natural_gas`; sigla exige contexto. |
| `product.lpg` | GLP | Gás liquefeito de petróleo; + botijão de GLP; − gás natural. | TriBusca/NCM·H | Composição/embalagem. |
| `product.ethanol_fuel` | Etanol combustível | Etanol destinado a combustível quando expresso; + etanol hidratado combustível; − álcool medicinal. | TriBusca/NCM·H | rel: `product.fuels`; anidro/hidratado. |
| `product.biodiesel` | Biodiesel | Combustível obtido de biomassa conforme norma; + biodiesel B100; − óleo de soja alimentar. | TriBusca/NCM·H | Mistura/composição. |
| `product.aviation_kerosene` | Querosene de aviação | Combustível de aviação do tipo querosene; + QAV; − querosene doméstico. | TriBusca/NCM·H | Sigla/contexto e especificação. |
| `product.fuel_oil` | Óleo combustível | Combustível líquido pesado para queima; + óleo combustível industrial; − lubrificante. | TriBusca/NCM·H | Grau/composição. |
| `product.lubricants` | Lubrificantes | Óleos/preparações para lubrificação; + óleo lubrificante automotivo; − óleo comestível. | TriBusca/NCM·H | Base e aditivos. |
| `product.coal` | Carvão mineral | Combustível mineral sólido; + carvão mineral; − carvão vegetal. | TriBusca/NCM·H | Grau/preparo. |
| `product.wood_charcoal` | Carvão vegetal | Combustível derivado da carbonização vegetal; + carvão de madeira; − carvão mineral. | TriBusca/NCM·H | Origem/apresentação. |
| `product.biogas` | Biogás | Gás obtido de matéria orgânica; + biogás de biodigestor; − gás natural fóssil. | TriBusca/NCM·H | Composição e fornecimento. |
| `product.batteries` | Baterias | Dispositivos de armazenamento eletroquímico; + bateria de lítio; − fornecimento de energia elétrica. | TriBusca/NCM·H | Química/capacidade/finalidade. |
| `product.solar_panels` | Módulos fotovoltaicos | Módulos que convertem luz em eletricidade; + painel fotovoltaico; − aquecedor solar de água. | TriBusca/NCM·H | Configuração e componente. |
| `product.electric_generators` | Geradores elétricos | Máquinas de geração elétrica; + gerador a diesel; − energia fornecida. | TriBusca/NCM·H | Tecnologia/potência. |
| `product.hydrogen` | Hidrogênio | Gás hidrogênio como mercadoria/insumo; + hidrogênio comprimido; − eletricidade. | TriBusca/NCM·H | Pureza/forma/uso. |
| `product.ammonia` | Amônia | Substância amônia e apresentações industriais; + amônia anidra; − fertilizante NPK genérico. | TriBusca/NCM·H | Pureza/solução e uso. |
| `product.ethanol_industrial` | Etanol industrial | Álcool etílico de uso industrial não identificado como combustível; + etanol para processo químico; − bebida destilada. | TriBusca/NCM·H | Teor/denaturação/uso. |

#### Construção, metais, química, papel e têxteis

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `product.cement` | Cimento | Ligante mineral para construção; + cimento Portland; − concreto pronto. | TriBusca/NCM·H | Tipo/composição. |
| `product.ready_mix_concrete` | Concreto usinado | Mistura pronta de concreto; + concreto entregue à obra; − cimento ensacado. | TriBusca/NCM·H | Estado/serviço de aplicação separados. |
| `product.sand` | Areia | Material granular mineral/industrial descrito como areia; + areia para construção; − vidro. | TriBusca/NCM·H | Composição/uso. |
| `product.gravel` | Brita/agregados pétreos | Pedra britada/agregado para construção; + brita graduada; − minério metálico. | TriBusca/NCM·H | Granulometria/composição. |
| `product.clay_bricks` | Tijolos cerâmicos | Blocos/tijolos de argila cozida; + tijolo cerâmico; − bloco de concreto. | TriBusca/NCM·H | Forma/finalidade. |
| `product.ceramic_tiles` | Revestimentos cerâmicos | Placas cerâmicas para pisos/paredes; + porcelanato; − tijolo estrutural. | TriBusca/NCM·H | Material/acabamento. |
| `product.glass` | Vidro | Família de vidro e artigos de vidro; + chapa de vidro; − plástico transparente. | TriBusca/NCM·H | Forma/transformação. |
| `product.timber` | Madeira | Madeira e produtos primários dela; + madeira serrada; − móvel acabado. | TriBusca/NCM·H | Espécie/processamento. |
| `product.steel` | Aço | Liga ferrosa de aço em forma não especificada; + chapa de aço; − alumínio. | TriBusca/NCM·H | Composição/forma para NCM. |
| `product.iron_ore` | Minério de ferro | Minério de ferro extraído/beneficiado; + minério de ferro; − chapa de aço. | TriBusca/NCM·H | Teor/beneficiamento. |
| `product.aluminum` | Alumínio | Metal alumínio e formas primárias; + lingote de alumínio; − aço. | TriBusca/NCM·H | Liga/forma/obra acabada. |
| `product.copper` | Cobre | Metal cobre e formas primárias; + fio de cobre; − cabo de fibra óptica. | TriBusca/NCM·H | Pureza/forma. |
| `product.plastic_resins` | Resinas plásticas | Polímeros plásticos em forma primária; + grânulo de polietileno; − embalagem plástica acabada. | TriBusca/NCM·H | Polímero/composição. |
| `product.plastic_packaging` | Embalagens plásticas | Recipientes/envoltórios de plástico; + garrafa PET vazia; − resina PET a granel. | TriBusca/NCM·H | Material/formato. |
| `product.paper` | Papel | Papel em bobina/folha sem finalidade especificada; + papel de impressão; − livro impresso. | TriBusca/NCM·H | Gramatura/revestimento. |
| `product.cardboard` | Papelão | Material de papel espesso/cartonado; + chapa de papelão; − caixa já formada. | TriBusca/NCM·H | Forma/estrutura. |
| `product.packaging` | Embalagens | Família de invólucros/recipientes comerciais; + caixa de transporte; − produto nela acondicionado. | TriBusca/NCM·H | Material/função; não NCM único. |
| `product.textile_fabrics` | Tecidos | Tecidos têxteis em peça; + tecido de algodão; − roupa pronta. | TriBusca/NCM·H | Fibra/tecelagem/acabamento. |
| `product.apparel` | Vestuário | Peças de roupa; + camisa; − tecido em rolo. | TriBusca/NCM·H | Material/uso. |
| `product.footwear` | Calçados | Produtos usados como calçado; + sapato; − couro em peça. | TriBusca/NCM·H | Cabedal/solado. |
| `product.cosmetics` | Cosméticos | Preparações cosméticas para uso humano; + creme facial; − medicamento. | TriBusca/NCM·H | Finalidade/composição/regulação. |
| `product.cleaning_agents` | Saneantes/produtos de limpeza | Preparações para limpeza/desinfecção conforme contexto; + detergente doméstico; − reagente laboratorial. | TriBusca/NCM·H | Função/composição. |
| `product.industrial_reagents` | Reagentes químicos | Substâncias/preparações para reação/análise; + reagente laboratorial; − medicamento pronto. | TriBusca/NCM·H | Composição/apresentação. |

#### Máquinas, veículos, eletrônica e saúde

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `product.tractors` | Tratores | Veículos/máquinas de tração; + trator agrícola; − implemento rebocado sem trator. | TriBusca/NCM·H | rel: `product.vehicles`; uso/potência. |
| `product.harvesters` | Colheitadeiras | Máquinas de colheita agrícola; + colheitadeira de grãos; − trator. | TriBusca/NCM·H | rel: `product.machines`; função técnica. |
| `product.irrigation_equipment` | Equipamentos de irrigação | Máquinas/sistemas para irrigação; + pivô central; − fertilizante. | TriBusca/NCM·H | Componentes separados de sistema completo. |
| `product.machine_tools` | Máquinas-ferramenta | Máquinas para usinagem/trabalho de materiais; + torno CNC; − ferramenta manual. | TriBusca/NCM·H | Função/eixos. |
| `product.industrial_robots` | Robôs industriais | Equipamentos programáveis de automação industrial; + braço robótico de produção; − software isolado. | TriBusca/NCM·H | Configuração/função. |
| `product.passenger_cars` | Automóveis de passageiros | Veículos para passageiros; + automóvel sedan; − caminhão de carga. | TriBusca/NCM·H | rel: `product.vehicles`; motorização/capacidade. |
| `product.trucks` | Caminhões | Veículos de transporte de carga; + caminhão; − ônibus. | TriBusca/NCM·H | rel: `product.vehicles`; peso/uso. |
| `product.buses` | Ônibus | Veículos para transporte coletivo de passageiros; + ônibus rodoviário; − caminhonete. | TriBusca/NCM·H | Capacidade/propulsão. |
| `product.auto_parts` | Autopeças | Peças de veículos automotores; + alternador automotivo; − veículo completo. | TriBusca/NCM·H | Aplicação específica não define NCM sozinha. |
| `product.tires` | Pneus | Pneus para veículos/equipamentos; + pneu de caminhão; − roda metálica. | TriBusca/NCM·H | Dimensão/uso/novo ou reformado. |
| `product.aircraft` | Aeronaves | Veículos aéreos; + avião; − peça de aeronave. | TriBusca/NCM·H | Tipo/peso/finalidade. |
| `product.vessels` | Embarcações | Veículos aquáticos; + navio de carga; − contêiner marítimo. | TriBusca/NCM·H | Propulsão/uso. |
| `product.computers` | Computadores | Máquinas de processamento de dados; + notebook; − licença de software. | TriBusca/NCM·H | Configuração/unidade. |
| `product.servers` | Servidores físicos | Computadores destinados a função de servidor; + servidor em rack; − serviço de nuvem. | TriBusca/NCM·H | rel: `product.computers`; função/configuração. |
| `product.mobile_phones` | Telefones celulares | Aparelhos de telefonia móvel; + smartphone; − serviço de telefonia. | TriBusca/NCM·H | Especificações técnicas. |
| `product.network_equipment` | Equipamentos de rede | Equipamentos para comutação/roteamento de dados; + roteador; − plano de internet. | TriBusca/NCM·H | Função/configuração. |
| `product.semiconductors` | Semicondutores | Componentes semicondutores; + circuito integrado; − computador completo. | TriBusca/NCM·H | Tipo/função. |
| `product.optical_fiber` | Fibra óptica | Fibra/cabo de transmissão óptica; + cabo óptico; − serviço de telecom. | TriBusca/NCM·H | Fibra nua vs cabo. |
| `product.active_pharmaceutical_ingredients` | Insumos farmacêuticos ativos | Substâncias ativas para fabricação de medicamento; + princípio ativo descrito; − comprimido final. | TriBusca/NCM·H | Pureza/composição/regulação. |
| `product.vaccines` | Vacinas | Preparações imunológicas vacinais; + vacina humana; − seringa vazia. | TriBusca/NCM·H | rel: `product.medicines` somente após revisão de inclusão. |
| `product.diagnostic_reagents` | Reagentes diagnósticos | Preparações para diagnóstico; + teste reagente in vitro; − medicamento terapêutico. | TriBusca/NCM·H | Uso/apresentação. |
| `product.surgical_instruments` | Instrumentos cirúrgicos | Instrumentos usados em cirurgia; + pinça cirúrgica; − fármaco. | TriBusca/NCM·H | Material/função. |
| `product.implants` | Implantes médicos | Dispositivos implantáveis; + prótese de quadril; − medicamento injetável. | TriBusca/NCM·H | rel: `product.medical_devices`; tipo/material. |
| `product.hospital_equipment` | Equipamentos hospitalares | Máquinas/equipamentos de assistência hospitalar; + monitor multiparamétrico; − mobiliário comum. | TriBusca/NCM·H | Função técnica. |
| `product.personal_protective_equipment` | Equipamentos de proteção individual | Artigos para proteção individual em trabalho/saúde; + máscara respiratória especificada; − máscara cosmética. | TriBusca/NCM·H | Material/uso/registro. |

“Grãos”, “sementes”, “carnes”, “medicamentos” e “soja” podem designar várias apresentações. Um NCM explicitado pelo ato entra em `commodity.ncm_reference` com edição; uma inferência de NCM exige especialista, regras da Receita e evidência material. Produto e família podem coexistir com descrição livre da norma sem apagar o texto original. `product.software` e `product.electricity` são conceitos de oferta/objeto de norma, **não** indicação de mercadoria classificável na NCM. Serviços financeiros, educacionais, de saúde, transporte e nuvem não foram artificialmente transformados em mercadorias: as dimensões `operation.service_provision`, `sector` e `subject` já os representam em nível inicial; a [NBS/NEBS 2.0](https://www.gov.br/mdic/pt-br/assuntos/sdic/comercio-e-servicos/nbs-nomenclatura-brasileira-de-servicos) oferece a referência oficial de serviços/intangíveis sob ótica de produto para auditoria TAX-03. A NBS também não prova automaticamente hipótese de ISS da LC 116.

### 10.3.1 Ampliação R2 — mercadorias e famílias transversais

Os conceitos abaixo ampliam a linguagem de produtos encontrada em normas de mineração, combustíveis, química, saúde, construção, têxtil, bens de capital, transportes e comunicação. São propostas funcionais `TriBusca·T`; a [NCM e suas regras/notas](https://www.gov.br/receitafederal/pt-br/assuntos/aduana-e-comercio-exterior/classificacao-fiscal-de-mercadorias/ncm) servem para **verificar futuramente** cada mercadoria concreta, e não são fonte de correspondência NCM já aprovada. Composição, forma, processamento, uso e data podem mudar o código oficial. Nenhuma linha atribui NCM, incidência ou benefício.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `product.tobacco_leaf` | Tabaco em folha | Folha de tabaco como matéria-prima; + folhas de fumo para processamento; − cigarro acabado. | TriBusca·T | Estado/processamento para NCM. |
| `product.cigarettes` | Cigarros | Artigos de fumar em formato de cigarro; + maço de cigarros; − folha de tabaco. | TriBusca·T | Composição e enquadramento legal por edição. |
| `product.cigars` | Charutos | Artigos de fumar em formato de charuto; + charuto acabado; − cigarro. | TriBusca·T | Não inferir imposto seletivo por termo isolado. |
| `product.gold` | Ouro | Metal ouro como objeto material amplo; + barra de ouro; − joia de metal não identificado. | CF/TriBusca·H | Forma/finalidade e regime jurídico separados. Ouro definido em lei como ativo financeiro ou instrumento cambial sujeita-se exclusivamente ao IOF (CF art. 153, §5º); mercadoria × ativo financeiro exige prova. |
| `product.silver` | Prata | Metal prata como objeto material amplo; + prata em lingote; − joia apenas prateada. | TriBusca·T | Pureza e apresentação para NCM. |
| `product.precious_stones` | Pedras preciosas | Gemas naturais/sintéticas descritas como pedras preciosas; + diamante lapidado; − brita comum. | TriBusca·T | Tipo e lapidação exigem prova. |
| `product.jewelry` | Joias | Artigos de adorno de material precioso conforme descrição; + anel de ouro; − lingote bruto. | TriBusca·T | Material e composição separados. |
| `product.copper_ore` | Minério de cobre | Material mineral destinado à obtenção de cobre; + concentrado de minério de cobre; − cobre refinado. | TriBusca·T | Teor/beneficiamento para NCM. |
| `product.bauxite` | Bauxita | Minério de alumínio em apresentação mineral; + bauxita extraída; − alumínio metálico. | TriBusca·T | Não inferir classificação por atividade de mineradora. |
| `product.limestone` | Calcário mineral | Rocha calcária sem finalidade agrícola presumida; + calcário extraído; − cimento acabado. | TriBusca·T | rel: `product.agricultural_lime`; uso/composição não equivalem. |
| `product.graphite` | Grafite | Material carbonáceo grafítico; + grafite natural; − carvão mineral genérico. | TriBusca·T | Natural/sintético e forma separados. |
| `product.lithium_ore` | Minério de lítio | Material mineral com lítio como objeto econômico; + concentrado mineral de lítio; − bateria de lítio. | TriBusca·T | Mineral e produto químico distintos. |
| `product.phosphate_rock` | Rocha fosfática | Mineral fosfatado usado como matéria-prima; + fosfato natural extraído; − fertilizante formulado. | TriBusca·T | Composição/processamento para NCM. |
| `product.potash` | Potassa | Sais potássicos como matéria-prima; + cloreto de potássio indicado; − adubo misto sem teor especificado. | TriBusca·T | Termo comercial polissêmico; TAX-03 verifica. |
| `product.salt` | Sal | Cloreto de sódio comercial em apresentações diversas; + sal industrial; − solução química não identificada. | TriBusca·T | Uso e processamento para NCM. |
| `product.naphtha` | Nafta | Fração hidrocarboneto identificada como nafta; + nafta petroquímica; − gasolina acabada. | TriBusca·T | Corrente/uso e edição regulatória importam. |
| `product.biomethane` | Biometano | Gás renovável especificado como biometano; + biometano purificado; − biogás bruto. | TriBusca·T | rel: `product.biogas`; especificação necessária. |
| `product.aviation_gasoline` | Gasolina de aviação | Combustível para aviação de tipo gasolina; + AVGAS explicitada; − querosene de aviação. | TriBusca·T | pai: `product.gasoline`; tipo técnico. |
| `product.marine_fuel` | Combustível marítimo | Combustível formulado/destinado à navegação; + bunker marítimo descrito; − diesel comum sem uso indicado. | TriBusca·T | Mistura/especificação para NCM; não subtipo universal. |
| `product.sulfuric_acid` | Ácido sulfúrico | Substância química identificada; + ácido sulfúrico industrial; − fertilizante ácido genérico. | TriBusca·T | Concentração e mistura. |
| `product.caustic_soda` | Soda cáustica | Hidróxido de sódio em apresentação descrita; + soda cáustica em solução; − carbonato de sódio. | TriBusca·T | Forma/concentração. |
| `product.urea` | Ureia | Substância ureia, sem finalidade única presumida; + ureia granulada; − fertilizante composto sem ureia comprovada. | TriBusca·T | Uso fertilizante/industrial separado. |
| `product.pesticide_active_ingredient` | Ingrediente ativo de defensivo | Substância ativa destinada a formulação de defensivo; + princípio ativo identificado; − produto formulado completo. | TriBusca·T | Composição e registro a verificar. |
| `product.petroleum_resins` | Resinas petroquímicas | Resinas produzidas de insumos petroquímicos; + resina petroquímica especificada; − embalagem plástica pronta. | TriBusca·T | Tipo/polímero para NCM. |
| `product.sweetened_beverages` | Bebidas adoçadas | Bebidas com adição de açúcar/adoçante explicitada; + bebida açucarada descrita; − água sem adição. | TriBusca·T | Sobrepõe refrigerantes; não inferir IS. |
| `product.coffee_extract` | Extrato de café | Preparação concentrada de café; + extrato solúvel de café; − grão de café cru. | TriBusca·T | Forma/preparação. |
| `product.fishmeal` | Farinha de peixe | Produto obtido de pescado para uso industrial/alimentação animal; + farinha de peixe; − peixe fresco. | TriBusca·T | Uso e processamento para NCM. |
| `product.animal_hides` | Couros e peles brutos | Peles animais antes de curtimento; + couro bovino cru; − calçado de couro. | TriBusca·T | Espécie/tratamento. |
| `product.finished_leather` | Couro curtido/acabado | Material de couro após curtimento; + couro curtido em peça; − pele crua. | TriBusca·T | Acabamento e apresentação. |
| `product.wool` | Lã | Fibra animal de lã em estado descrito; + lã lavada; − tecido sintético. | TriBusca·T | Processamento para NCM. |
| `product.wood_pulp` | Celulose/polpa de madeira | Polpa fibrosa derivada de madeira; + celulose para papel; − folha de papel acabada. | TriBusca·T | Processo/forma. |
| `product.corrugated_boxes` | Caixas de papelão ondulado | Embalagens rígidas de papelão ondulado; + caixa de embarque; − papel em bobina. | TriBusca·T | Material e montagem. |
| `product.cotton_yarn` | Fio de algodão | Fio têxtil de algodão; + fio para tecelagem; − algodão em pluma. | TriBusca·T | Composição e torção. |
| `product.synthetic_yarn` | Fio sintético | Fio têxtil de fibra sintética; + fio de poliéster; − fibra natural sem fiação. | TriBusca·T | Polímero/composição. |
| `product.nonwoven_fabrics` | Não tecidos | Mantas têxteis obtidas sem tecelagem convencional; + manta não tecida; − tecido plano. | TriBusca·T | Gramatura/material. |
| `product.diapers` | Fraldas | Artigos absorventes para uso infantil ou adulto; + fralda descartável; − absorvente industrial de óleo. | TriBusca·T | Uso/composição. |
| `product.medical_gloves` | Luvas médicas | Luvas destinadas a procedimento de saúde; + luva cirúrgica; − luva de jardinagem. | TriBusca·T | Material e finalidade não dão NCM automático. |
| `product.hearing_aids` | Aparelhos auditivos | Dispositivos de assistência auditiva; + prótese auditiva; − fone comum. | TriBusca·T | Função/registro específico. |
| `product.prostheses` | Próteses | Dispositivos para substituir parte/função corporal; + prótese de membro; − instrumento cirúrgico. | TriBusca·T | Material e uso. |
| `product.wheelchairs` | Cadeiras de rodas | Equipamentos de mobilidade assistida; + cadeira de rodas motorizada; − bicicleta comum. | TriBusca·T | Motorização/apresentação. |
| `product.eyeglasses` | Óculos | Artigos ópticos de uso pessoal; + óculos de grau; − lente solta não montada. | TriBusca·T | Lente/armação e finalidade. |
| `product.blood_products` | Hemoderivados | Preparações derivadas de sangue para uso em saúde; + albumina humana derivada; − sangue para exame não processado. | TriBusca·T | Definição técnica/regulatória por produto. |
| `product.medical_oxygen` | Oxigênio medicinal | Oxigênio especificado para uso médico; + cilindro de oxigênio medicinal; − oxigênio industrial não qualificado. | TriBusca·T | Grau/uso e embalagem. |
| `product.industrial_gases` | Gases industriais | Gases fornecidos para processo industrial; + argônio industrial; − oxigênio medicinal comprovado. | TriBusca·T | Família funcional, gás concreto separado. |
| `product.lithium_batteries` | Baterias de lítio | Acumuladores baseados em química de lítio; + bateria de íons de lítio; − pilha alcalina. | TriBusca·T | pai: `product.batteries`; composição/aplicação. |
| `product.electric_motors` | Motores elétricos | Máquinas que convertem energia elétrica em movimento; + motor elétrico industrial; − gerador elétrico. | TriBusca·T | Potência/finalidade. |
| `product.power_transformers` | Transformadores elétricos | Equipamentos de transformação de tensão/corrente; + transformador de distribuição; − gerador. | TriBusca·T | Potência e forma. |
| `product.wind_turbines` | Aerogeradores | Equipamentos geradores movidos por vento; + turbina eólica; − painel fotovoltaico. | TriBusca·T | Relaciona-se a `product.electric_generators`, sem equivalência. |
| `product.electric_vehicles` | Veículos elétricos | Veículos com propulsão elétrica descrita; + automóvel elétrico; − carregador elétrico. | TriBusca·T | Tipo de veículo/bateria/propulsão separados. |
| `product.motorcycles` | Motocicletas | Veículos motorizados de duas/três rodas conforme descrição; + motocicleta; − bicicleta sem motor. | TriBusca·T | Motorização/cilindrada. |
| `product.rail_vehicles` | Veículos ferroviários | Material rodante ferroviário; + vagão de carga; − caminhão rodoviário. | TriBusca·T | Vagão/locomotiva distintos. |
| `product.construction_equipment` | Máquinas de construção | Equipamentos usados em obra; + escavadeira; − cimento. | TriBusca·T | Máquina concreta e função. |
| `product.agricultural_drones` | Drones agrícolas | Aeronaves não tripuladas descritas para atividade agrícola; + drone de pulverização; − pulverizador terrestre. | TriBusca·T | Uso declarado não determina NCM. |
| `product.firearms` | Armas de fogo | Armas de fogo como mercadoria descrita; + espingarda; − ferramenta pneumática. | TriBusca·T | Tipo e regime regulatório por ato. |
| `product.ammunition` | Munições | Projéteis/cartuchos destinados a arma de fogo; + cartucho de munição; − peça de máquina. | TriBusca·T | Tipo/composição. |
| `product.books` | Livros | Obras publicadas em formato material ou digital qualificado pelo ato; + livro impresso; − caderno em branco. | CF/TriBusca·H | Formato e conceito jurídico de livro exigem prova; imunidade não inferida. Imunidade do CF art. 150, VI, d depende do conceito jurídico de livro. |
| `product.newspapers` | Jornais | Publicações jornalísticas periódicas; + edição de jornal; − folheto publicitário isolado. | CF/TriBusca·H | Mídia e formato separados; imunidade não inferida. |
| `product.artworks` | Obras de arte | Objetos artísticos descritos como obra; + pintura original; − reprodução decorativa indistinta. | TriBusca·T | Autoria/originalidade e NCM por prova. |

### 10.4 Esfera, jurisdição, órgão e competência

Esses eixos existem desde a TAX-01. A v1 fixa sua **tipagem funcional**, deixando os códigos de UF/município e identidades de órgão em referências oficiais versionadas. `jurisdiction.issuing` (ente emissor), `jurisdiction.applicable` (território de aplicação), `jurisdiction.operation_origin` e `jurisdiction.operation_destination` são papéis de vínculo territorial distintos, não quatro cópias de município. Um ato estadual pode afetar operação interestadual; o destino não se torna ente emissor. `authority.official_body_reference` somente vincula órgão do Executivo federal dentro do escopo do SIORG; órgãos estaduais/municipais exigem fonte local. `competence.taxing` é relação entre ente, tributo, fundamento e tempo, não tag de empresa.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `sphere.federal` | Federal | Esfera da União como emissora/competente; + lei federal; − decreto municipal. | CF·H | Não prova alcance a cada operação. |
| `sphere.state` | Estadual | Esfera de Estado; + lei de Goiás; − lei do Distrito Federal automaticamente. | CF/IBGE·H | UF externa da edição aplicável. |
| `sphere.district` | Distrital | Esfera do Distrito Federal; + lei distrital; − lei de município. | CF/IBGE·H | Competências estaduais/municipais conforme CF. |
| `sphere.municipal` | Municipal | Esfera de Município; + lei de Goiânia; − LC 116 federal. | CF/IBGE·H | Município oficial e período. |

`jurisdiction.ibge_uf_reference` e `jurisdiction.ibge_municipality_reference` são tipos conceituais de referência oficial IBGE·O (status `proposed`): positivo “SP”/código municipal oficial identificável na edição; negativo nome homônimo ou UF inferida apenas do domicílio do cliente. `authority.official_body_reference` é tipo híbrido (SIORG/ente·H, `proposed`): positivo órgão emissor explicitado no cabeçalho oficial; negativo órgão presumido pelo tema. Essas três identidades não carregam nome de empresa nem criam catálogos manuais. Órgão emissor ≠ órgão competente para aplicar a regra; sucessão de órgão precisa histórico. Situação normativa (revogado, suspenso, eficaz) é derivada de eventos e fatos temporais por dispositivo, não rótulo permanente.

## 11. Dicionário — sujeitos (`subject`)

**Universo:** aberto e relacional; papéis jurídicos são definidos por tributo, operação e norma. `Pessoa física/jurídica` é tipo jurídico; `produtor rural` pode ser papel/sujeito de regra e segmento de negócio, com significados diferentes; identificadores e dados reais de pessoa/empresa pertencem à camada privada. Fonte CTN/CF/LC116 ou legislação específica para a aplicação; recorte `H`.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `subject.taxpayer` | Contribuinte | Sujeito passivo com relação pessoal e direta com fato gerador, conforme CTN; + contribuinte legal de ICMS; − mera empresa citada. | CTN·H | Papel por tributo/fato. |
| `subject.tax_responsible` | Responsável tributário | Sujeito cuja obrigação decorre de disposição legal sem ser contribuinte direto; + responsável por retenção legal; − contratante sem norma. | CTN·H | Não inferir responsabilidade por contrato. |
| `subject.tax_substitute` | Substituto tributário | Responsável legal que recolhe em regime de substituição; + fabricante designado substituto; − fabricante comum. | CTN-R5/RICMS-MT-ST-R6·H | pai: `subject.tax_responsible` apenas papel funcional. |
| `subject.substituted` | Substituído tributário | Sujeito cujo tributo é recolhido por substituto conforme regime; + varejista substituído expressamente; − todo varejista. | NEEDS_EVIDENCE·H | Relação à operação/ST. |
| `subject.rural_producer` | Produtor rural | Pessoa que exerce produção rural no sentido do ato; + norma endereçada ao produtor rural; − vendedor de fertilizantes. | L8212/RICMS-MT-ANEXO-VII-R5·H | rel: `sector.rural_production`, sem equivalência. |
| `subject.natural_person` | Pessoa física | Sujeito individual humano; + IRPF para pessoa física; − pessoa jurídica. | CTN·H | Não armazenar identidade pessoal global. |
| `subject.legal_entity` | Pessoa jurídica | Ente com personalidade jurídica; + IRPJ de PJ; − pessoa física. | CTN·H | Não armazenar CNPJ no conceito. |
| `subject.importer` | Importador | Pessoa que importa na operação juridicamente descrita; + importador indicado na norma; − fornecedor estrangeiro apenas. | NEEDS_EVIDENCE·H | Papel por operação, não segmento automático. |
| `subject.exporter` | Exportador | Pessoa que exporta na operação descrita; + exportador indicado; − comprador interno. | NEEDS_EVIDENCE·H | Papel por operação. |
| `subject.sender` | Remetente | Parte que remete bem/documento; + remetente da NF-e; − transportador por presunção. | DF-e·H | Pode diferir de vendedor. |
| `subject.recipient` | Destinatário | Parte de destino indicada no ato/documento; + destinatário de mercadoria; − comprador sempre, sem prova. | DF-e·H | Pode diferir do adquirente. |
| `subject.service_customer` | Tomador | Quem toma serviço na relação descrita; + tomador de serviço de transporte; − destinatário de mercadoria isolado. | LC116/NFSE·H | Contratos complexos exigem revisão. |
| `subject.service_provider` | Prestador | Quem realiza prestação de serviço; + prestador de ISS; − fabricante de mercadoria sem serviço. | LC116/NFSE·H | Não inferir ISS sem hipótese legal. |
| `subject.carrier` | Transportador | Parte que executa transporte; + transportadora no CT-e; − remetente que contratou frete. | DF-e·H | Pode ser terceiro. |
| `subject.final_consumer` | Consumidor final | Destinatário que encerra cadeia de circulação/uso conforme regra; + consumidor final expressamente citado; − todo comprador. | CF/NEEDS_EVIDENCE·H | Qualificação jurídica varia com tributo. |
| `subject.non_taxpayer` | Não contribuinte | Pessoa que não é contribuinte de tributo **identificado** na hipótese; + não contribuinte do ICMS; − pessoa física automaticamente. | CF/NEEDS_EVIDENCE·H | Tributo e operação obrigatórios. |
| `subject.buyer` | Adquirente | Parte que adquire bem/direito; + adquirente em venda à ordem; − destinatário físico presumido. | TriBusca/NEEDS_EVIDENCE·H | Distinto de destinatário. |
| `subject.supplier` | Fornecedor | Parte que fornece bem/serviço; + fornecedor em contrato; − transportador que só entrega. | TriBusca/NEEDS_EVIDENCE·H | Papel econômico, não regime jurídico. |
| `subject.withholding_agent` | Fonte pagadora/retentora | Parte designada a reter/recolher valor na fonte; + tomador obrigado a reter ISS; − pagador sem dever legal. | CTN/NEEDS_EVIDENCE·H | Pode sobrepor responsável, sem inferência automática. |
| `subject.intermediary` | Intermediário | Parte que intermedeia operação, inclusive plataforma, quando ato lhe atribui papel; + marketplace intermediador expresso; − todo software SaaS. | TriBusca/NEEDS_EVIDENCE·H | Responsabilidade específica requer lei. |
| `subject.cooperative_entity` | Sociedade cooperativa | Tipo de organização jurídica cooperativa quando o ato a identifica; + norma dirigida a sociedade cooperativa; − qualquer empresa agroindustrial. | CF/L5764·H | Ramo, operações e regime separados; não é segmento automático. Ato cooperativo e “adequado tratamento tributário” (CF art. 146, III, c) exigem hipótese expressa. |
| `subject.nonprofit_entity` | Entidade sem fins lucrativos | Organização caracterizada no ato pela ausência de finalidade lucrativa; + norma sobre entidade beneficente; − empresa que fez doação. | CF/CTN·H | Condições legais de imunidade/isenção não inferidas. Requisitos de imunidade em CF art. 150, VI, c e CTN art. 14. |
| `subject.public_entity` | Ente ou entidade pública | Pessoa jurídica de direito público identificada no ato; + norma dirigida a município ou autarquia; − órgão interno da administração tomado como pessoa jurídica própria. | CF·H | Órgão emissor é papel de `authority.*`; imunidade recíproca requer ente, atividade e dispositivo aplicável, sem atribuição automática a toda entidade estatal. |
| `subject.mei` | Microempreendedor individual | Pessoa enquadrada como MEI nos termos da LC 123 quando o ato trata dessa categoria; + norma dirigida a MEI; − toda microempresa do Simples. | LC123·H | rel: `regime.simei`; enquadramento efetivo de empresa/CNPJ é privado, nunca inferido da menção global. |
| `subject.non_resident` | Não residente | Pessoa sem residência ou domicílio fiscal no Brasil conforme a regra do tributo; + remessa a beneficiário no exterior; − estrangeiro residente. | NEEDS_EVIDENCE·H | Critério de residência por tributo. |
| `subject.successor` | Sucessor tributário | Quem responde por tributos de outrem por sucessão nas hipóteses do CTN; + incorporadora responde por tributos da incorporada; − comprador de ativo isolado sem hipótese legal. | CTN·H | pai: `subject.tax_responsible` (CTN arts. 129–133). |

## 12. Dicionário — eventos normativos (`event`) e tipo de ato (`act_type`)

**Universo:** aberto/funcional. Evento é verbo jurídico qualificado por ato fonte, ato/dispositivo alvo, data, condição e evidência. Um decreto pode alterar lei, regulamentar lei e prorrogar prazo em dispositivos diferentes. **Não inferir evento do título ou mera citação.** Tipo de ato é dimensão separada, com correspondência à nomenclatura oficial do ente.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `event.institutes` | Institui | Ato cria tributo, obrigação, regime ou regra no escopo de competência; + “fica instituído”; − apenas menciona tributo existente. | NEEDS_EVIDENCE/TriBusca·H | Alvo e autoridade necessários. |
| `event.amends` | Altera | Ato modifica texto/efeito de ato ou dispositivo anterior; + “altera o art. 2º”; − cita o art. 2º. | NEEDS_EVIDENCE/TriBusca·H | A→B dirigido, alvo preciso. |
| `event.regulates` | Regulamenta | Ato detalha execução de norma superior; + decreto regulamenta lei; − repete lei em ementa. | NEEDS_EVIDENCE/TriBusca·H | Competência e alvo. |
| `event.revokes` | Revoga | Ato retira vigência de ato/dispositivo segundo regras temporais; + “revoga o art. 5º”; − altera redação. | NEEDS_EVIDENCE/TriBusca·H | Total/parcial/data. |
| `event.suspends` | Suspende efeitos | Ato suspende vigência/efeitos/exigibilidade de alvo delimitado; + “suspende efeitos do art.”; − diferimento de ICMS. | NEEDS_EVIDENCE/TriBusca·H | Objeto e período obrigatórios. |
| `event.reinstates` | Restabelece | Ato volta a dar eficácia ou texto a regra antes suspensa/revogada quando juridicamente válido; + “restabelece vigência”; − republicação sem efeito. | NEEDS_EVIDENCE/TriBusca·H | Não inferir repristinação tácita. |
| `event.extends` | Prorroga | Ato estende prazo/validade; + “prorroga até 31/12”; − muda alíquota sem prazo. | NEEDS_EVIDENCE/TriBusca·H | Alvo, prazo anterior/novo. |
| `event.postpones` | Posterga | Ato desloca início de vigência/efeitos/obrigação para depois; + “início passa a 1º/7”; − prorroga prazo já em curso. | NEEDS_EVIDENCE/TriBusca·H | Distinguir prorrogação. |
| `event.corrects` | Retifica/corrige | Ato corrige erro material de publicação/texto; + retificação oficial; − alteração normativa substancial presumida. | NEEDS_EVIDENCE/TriBusca·H | Efeito temporal depende de análise. |
| `event.consolidates` | Consolida | Ato reúne normas/textos mantendo ou esclarecendo estrutura conforme regime de consolidação; + texto consolidado oficial; − simples nova lei. | NEEDS_EVIDENCE/TriBusca·H | Não presumir revogação tácita. |
| `event.disciplines` | Disciplina | Ato estabelece procedimento/regra de execução; + portaria disciplina entrega; − mero comunicado. | NEEDS_EVIDENCE/TriBusca·H | Verbo amplo; exigir objeto. |
| `event.clarifies` | Esclarece | Ato interpretativo/orientativo esclarece aplicação; + solução de consulta esclarece entendimento; − cria obrigação nova por presunção. | NEEDS_EVIDENCE/TriBusca·H | Força vinculante conforme ato/ente. |
| `event.repeals_partially` | Revoga parcialmente | Revogação expressa de parte identificada; + revoga inciso; − revoga decreto todo. | NEEDS_EVIDENCE/TriBusca·H | pai: `event.revokes`; granularidade importa. |

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `act_type.law` | Lei | Ato legislativo em sentido formal no ente competente; + lei municipal; − decreto. | CF/NEEDS_EVIDENCE·H | Federal/estadual/municipal via jurisdição. |
| `act_type.complementary_law` | Lei complementar | Lei com rito e matérias próprios quando exigida; + LC 116; − lei ordinária. | CF/NEEDS_EVIDENCE·H | Não é evento. |
| `act_type.decree` | Decreto | Ato executivo denominado decreto; + decreto regulamentador; − portaria. | NEEDS_EVIDENCE·H | Tipo não prova `event.regulates`. |
| `act_type.ordinance` | Portaria | Ato administrativo denominado portaria; + portaria da RFB; − resolução. | NEEDS_EVIDENCE·H | Competência varia. |
| `act_type.resolution` | Resolução | Ato de órgão/colegiado denominado resolução; + resolução CGSN; − convênio ICMS. | NEEDS_EVIDENCE·H | Órgão e força normativa separados. |
| `act_type.icms_agreement` | Convênio ICMS | Ato celebrado no âmbito CONFAZ conforme competência; + Convênio ICMS identificado; − decreto estadual que o incorpora. | CONFAZ·H | Ratificação/incorporação/efeitos não presumidos. |
| `act_type.sinief_adjustment` | Ajuste SINIEF | Ato do SINIEF sobre documentos/procedimentos fiscais; + Ajuste SINIEF de NF-e; − nota técnica. | CONFAZ·H | Alcance e versão por ato. |
| `act_type.technical_note` | Nota técnica | Documento técnico oficial que especifica leiaute/procedimento no seu escopo; + NT NF-e; − lei que institui tributo. | DF-e/NFSE·H | Eficácia depende de fundamento/cronograma. |

## 13. Dicionário — impactos potenciais (`impact_operational`, `impact_system`)

**Universo:** aberto, vocabulário TriBusca; requer ligação a alteração comprovada e verbo “pode afetar” enquanto não houver contexto privado. Sistemas proprietários são **componentes potencialmente envolvidos**, jamais prova de uso pelo cliente. A NF-e aparece em `document.nfe` como objeto jurídico/documental e em `impact_operational.fiscal_issuance` como processo sistêmico; não são o mesmo conceito.

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `impact_operational.billing` | Faturamento | Processo comercial de faturar possivelmente afetado; + mudança de regra de emissão em venda; − simples ato sem operação. | TriBusca·T | Não afirmar mudança necessária a empresa. |
| `impact_operational.purchasing` | Compras | Processo de aquisição possivelmente afetado; + nova regra de crédito de entradas; − alteração só de exportação sem compras. | TriBusca·T | Condições de compra. |
| `impact_operational.receiving` | Recebimento | Conferência/entrada de bens/documentos; + validação de NF-e recebida; − entrega de DCTFWeb sem entrada. | TriBusca·T | Processo, não documento. |
| `impact_operational.tax_calculation` | Apuração tributária | Cálculo e consolidação do tributo; + mudança de base de cálculo; − mudança meramente editorial. | TriBusca·T | Relevância concreta privada. |
| `impact_operational.tax_master_data` | Cadastro fiscal | Parametrização de cadastros tributários; + nova classificação de operação; − ato sem parâmetro cadastral. | TriBusca·T | Não supor ERP. |
| `impact_operational.pricing` | Formação de preço | Processo de precificação potencialmente afetado; + mudança de carga tributária aplicável à venda; − mudança de leiaute sem preço. | TriBusca·T | Efeito econômico não automático. |
| `impact_operational.fiscal_issuance` | Emissão fiscal | Emissão de documento fiscal; + novo campo obrigatório NF-e; − relatório contábil interno. | TriBusca·T | rel: `document.nfe` quando qualificado. |
| `impact_operational.bookkeeping` | Escrituração | Registro fiscal/contábil estruturado; + novo registro EFD; − venda sem dever novo. | TriBusca·T | Qualificar obrigação. |
| `impact_operational.tax_closing` | Fechamento fiscal | Consolidação de período e entrega/apuração; + alteração de prazo de fechamento; − lei sem prazo. | TriBusca·T | Prazo estruturado. |
| `impact_operational.compliance` | Conformidade/fiscalização | Controles de cumprimento e fiscalização potencialmente afetados; + novo dever de informação; − norma sem dever. | TriBusca·T | Guarda-chuva amplo, auditável. |

| Código | Rótulo | Definição; + / − | Âncora | Vínculo/alerta |
|---|---|---|---|---|
| `impact_system.erp` | ERP | Camada de sistema de gestão potencialmente envolvida; + integração fiscal de ERP pode precisar revisão; − norma prova uso de ERP pelo cliente. | TriBusca·T | Nome genérico, não instalação. |
| `impact_system.sap` | SAP | Família de ERP SAP como alvo potencial de integração; + alteração relevante a configuração SAP se usado; − cliente usa SAP por presunção. | TriBusca·T | Marca/versão não inferida. |
| `impact_system.j1btax` | J1BTAX | Componente fiscal SAP citado como possível ponto de parametrização; + regra de cálculo que pode afetá-lo; − todo ato tributário exige J1BTAX. | TriBusca·T | Validação técnica futura; uso privado. |
| `impact_system.nfe_integration` | Integração NF-e | Interface/validação de emissão NF-e; + alteração de campo XML; − alteração só de ECD. | TriBusca/DF-e·H | rel: `document.nfe`, sem identidade comum. |
| `impact_system.drc` | DRC | Componente/processo denominado DRC em ambiente SAP, quando identificado; + exigência que pode tocar DRC conforme arquitetura do cliente; − toda norma impõe ajuste DRC. | TriBusca·T | **Sigla ambígua/tecnologia específica**; TAX-03 deve confirmar escopo. |
| `impact_system.pricing_engine` | Motor de precificação | Sistema de cálculo de preços; + regra tributária que integra preço; − simples comunicado fiscal. | TriBusca·T | Uso privado. |
| `impact_system.tax_master_data` | Cadastro sistêmico fiscal | Tabelas/parâmetros fiscais em sistema; + novo código exigido no cadastro; − mero conceito `sector.*`. | TriBusca·T | Nome do sistema não inferido. |
| `impact_system.sped_integration` | Integração SPED | Geração/transmissão de módulos SPED; + novo registro EFD; − NF-e por si só. | TriBusca/SPED·H | rel: `platform.sped`. |
| `impact_system.tax_engine` | Motor fiscal | Componente de cálculo/regras tributárias; + alteração de regra de cálculo; − cliente possui motor fiscal presumido. | TriBusca·T | Categoria técnica ampla. |

## 14. Vigência, tempo e relações entre atos

**Decisão:** não criar `time.currently_effective` ou `theme.vigente` como tag permanente. Usar fatos estruturados vinculados a ato/dispositivo: `published_at`, `effective_from`, `effects_from`, `effective_until`, `deadline_at`, `transition_from/to`, `retroactive_effects_from`, `condition`, `precision`, `time_zone`, `source_excerpt`, `confidence` e `status`. Ausência é `UNKNOWN`, não data arbitrária. Norma parcialmente vigente exige fatos por dispositivo. Data de publicação, início de vigência e produção de efeitos podem divergir. Prazo de entrega de obrigação não é fim de vigência da norma. Estado “vigente em 28/09/2026” seria consulta temporal derivada, não conceito fixo.

| Fato temporal | Exemplo positivo | Contraexemplo/risco |
|---|---|---|
| publicação | data do diário oficial | data da assinatura não substitui publicação |
| início de vigência | “entra em vigor na data da publicação” | não implica efeitos tributários imediatos em todos dispositivos |
| início de efeitos | “produz efeitos a partir de 1º/1” | não é necessariamente início de vigência |
| fim/revogação | revoga a partir de data expressa | não inferir revogação pelo silêncio de norma nova |
| prazo | entrega até dia definido | não confundir com validade da obrigação |
| transição | fases IBS/CBS/ICMS por período legal | não substituir classificação histórica |
| retroatividade | efeito retroativo expresso juridicamente aplicável | não presumir retroação de retificação |
| parcial/condição | somente dispositivos X/Y após evento Z | não marcar ato inteiro como vigente/sem efeito |

**Aresta dirigida entre atos:** `{source_act_version, source_disposition?, relation_type, target_act_version, target_disposition?, valid_from/to?, condition?, evidence, status}`. A fonte “A altera B” aponta A→B; ao consultar B pode haver visão inversa derivada “alterado por A”, mas ela não é nova relação jurídica emitida por B. O vínculo só é confirmado com identidade do alvo e texto oficial; alvo não localizado fica pendente, sem inventar documento. `cites`, `amends`, `revokes`, `regulates`, `complements`, `replaces`, `consolidates`, `extends`, `depends_on` são tipos distintos. Eventos §12 sem aresta correspondente (`suspends`, `reinstates`, `postpones`, `corrects`, `institutes`, `clarifies`) ficam sem tipo de aresta na v1; ver G20. `cites` não implica alteração; `replaces` exige substituição comprovada; `depends_on` não decorre de simples menção. Eventos §12 e arestas compartilham evidência, mas evento descreve ação e aresta liga atos. Exemplo positivo: decreto A “regulamenta a Lei B” ⇒ `event.regulates` e A→B `regulates`; negativo: decreto A apenas cita B na exposição ⇒ `cites` no máximo.

## 15. Hierarquias, relações e aliases controlados

**Hierarquias admitidas nesta proposta (sujeitas à TAX-03):** `theme.fine narrower_than theme.penalty`; `operation.resale narrower_than operation.sale` apenas no sentido econômico funcional; `subject.tax_substitute narrower_than subject.tax_responsible` como papel jurídico; `product.beef`, `product.poultry_meat` e `product.pork narrower_than product.meat` (derivados como farelo, óleo, farinha e chocolate permanecem `related_to`, não subtipo); `product.diesel` e `.gasoline narrower_than product.fuels`; `tax.cide_fuels narrower_than tax.cide` como subfamília; `event.repeals_partially narrower_than event.revokes`; `operation.transport_service narrower_than operation.service_provision`; R3: `tax.payroll_employer_contribution`, `tax.rat`, `tax.cprb` e `tax.rural_commercialization_contribution narrower_than tax.social_security_contribution`; `tax.cide_royalties narrower_than tax.cide`; `regime.simei narrower_than regime.simples_nacional`; `subject.successor narrower_than subject.tax_responsible`; `product.aviation_gasoline narrower_than product.gasoline`; `product.lithium_batteries narrower_than product.batteries`. Nenhuma hierarquia entre CNAE e segmento, NCM e produto, documento e obrigação. Relações de amplitude incerta ficam `related_to` ou candidato, não pai. Toda hierarquia exige revisão de inclusão semântica, ausência de ciclo e exemplos negativos.

**Relações tipadas propostas:** `sector.meatpacking related_to sector.slaughterhouse`, `.meat_products`, `.cold_storage`, `.meat_distribution`; `sector.meatpacking maps_to_official:overlap` aos CNAEs de frigorífico, nunca `exact` global; `sector.rural_production related_to subject.rural_producer`; `theme.tax_deferral about treatment.tax_deferral`; `document.nfe related_to impact_system.nfe_integration`; `obligation.efd_icms_ipi hosted_by platform.sped`; `document.dere fulfills obligation.dere` (inversa derivada `fulfilled_by`). Relação entre conceito e norma classificada exige evidência própria. **Propagação automática: nenhuma.**

**Tipos de relação da TAX-01, preservados nesta v1:** `narrower_than`/`broader_than` (subtipo verdadeiro; `pai:` nas tabelas), `part_of` (componente, sem herança de subtipo), `related_to` (associação sem equivalência), `maps_to_official:{exact|broader|narrower|overlap}` (correspondência com catálogo, edição e vigência), `replaced_by`/`supersedes` (continuidade histórica, sem sobrescrita) e `applies_to` (regra condicionada a produto, operação, sujeito ou território). Os quatro últimos tipos podem ter zero arestas exemplificadas nesta semente; continuam válidos no contrato e nunca propagam classificação automaticamente. `about` (tema → tratamento), `hosted_by` (obrigação → plataforma) e `fulfills` (documento → obrigação; inversa derivada `fulfilled_by`) são especializações **propostas** pela TAX-02 para revisão na TAX-03; até aprovação, podem ser representadas por `related_to` qualificada em metadados. “Modalidade de” em `tax.irpf`/`tax.irpj` não vira `narrower_than` por inferência. Relações entre atos são outro vocabulário (§14).

| Alias/termo | Conceito alvo | Tipo | Decisão e risco |
|---|---|---|---|
| “ISSQN” | `tax.iss` | `ABBREVIATION` | Proposto, condicionado ao contexto de imposto sobre serviços; “ISS” isolado pode ter homônimo fora do corpus fiscal. |
| “Imposto sobre Serviços” | `tax.iss` | `EXACT_LEXICAL` | Proposto no contexto jurídico brasileiro; não prova incidência de serviço específico. |
| “Contribuição para o Financiamento da Seguridade Social” | `tax.cofins` | `EXACT_LEXICAL` | Proposto; não colapsar com CBS. |
| “Nota Fiscal Eletrônica” | `document.nfe` | `EXACT_LEXICAL` | Proposto se contexto/documento é modelo 55; expressão genérica pode designar outros documentos. |
| “NFC-e” | `document.nfce` | `ABBREVIATION` | Proposto; hífen/grafia normalizados. |
| “Frigorífico - abate de bovinos” | `sector.meatpacking` | `SEARCH_RELATED` | Descritor CNAE/atividade, não alias exato da totalidade do segmento. |
| “Abatedouro” | `sector.slaughterhouse` | `SEARCH_RELATED` | **Não** exato; pode também indicar `sector.meatpacking` quando houver preparo integrado. |
| “Matadouro” | `sector.slaughterhouse` | `SEARCH_RELATED` | Pode variar conforme CNAE/contrato; revisão de sentido antes de converter a exato. |
| “Crédito” | — (candidatos: `theme.assessed_tax_credit`, `theme.input_credit`, `theme.presumed_credit`) | `AMBIGUOUS` | **Bloqueado** para mapeamento exato: pode ser crédito de entrada, crédito tributário, financeiro etc. |
| “ST” | `theme.tax_substitution` | `AMBIGUOUS` | Sigla precisa de contexto; não converter em tratamento aplicado automaticamente. |
| “DIFAL” | `theme.rate_difference` | `ABBREVIATION` | Proposto só no contexto de diferencial de alíquotas do ICMS; sigla isolada exige desambiguação. |
| “IRRF” | `tax.ir` | `SEARCH_RELATED` | Retenção na fonte, não novo tributo nem alias exato de IR inteiro. |
| “ITCD” | `tax.itcmd` | `ABBREVIATION` | Variante siglar/lexical contextual **somente** quando a jurisdição/edição confirmar a denominação do imposto; sem aplicação nacional automática. A jurisdição é metadado do vínculo, não nova classe de alias. |
| “Soja” | `product.soy` | `EXACT_LEXICAL` | Produto amplo; nunca NCM exato. |
| “DRC” | `impact_system.drc` | `AMBIGUOUS` | Não mapear sem contexto tecnológico. |
| “IE” | `tax.ie` | `AMBIGUOUS` | No corpus fiscal, “IE” quase sempre é Inscrição Estadual; mapear para Imposto de Exportação só com contexto aduaneiro expresso. |
| “Funrural” | `tax.rural_commercialization_contribution` | `SEARCH_RELATED` | Nome do antigo fundo, usado popularmente para a contribuição atual; não é denominação legal vigente. |
| “Sistema S” | `tax.third_party_contributions` | `SEARCH_RELATED` | Designa parte da família; Incra e outras destinações não são “Sistema S”. |
| “Desoneração da folha” | `tax.cprb` | `SEARCH_RELATED` | Pode designar outras medidas sobre folha; confirmar CPRB no texto. |
| “Split payment” | `theme.split_payment` | `EXACT_LEXICAL` | Termo usado na própria LC 214 (título da subseção dos arts. 31–35). |
| “Cashback” | `theme.personalized_refund` | `AMBIGUOUS` | Homônimo de programa comercial de varejo; só mapear com IBS/CBS e pessoa física no contexto. |

Aliases `EXACT_LEXICAL`, `ABBREVIATION` e `HISTORICAL_LABEL` seguem as classes da TAX-01 e continuam `proposed`; requerem validação de contexto, jurisdição e tempo para uso automático futuro. **R5 rejeita a promoção de `JURISDICTIONAL_LABEL`**: “ITCD” usa `ABBREVIATION` com jurisdição/edição obrigatórias no vínculo. `SEARCH_RELATED` só auxilia busca; `AMBIGUOUS` exige desambiguação/abstenção. Termo rejeitado também deve permanecer em histórico de decisão. Não há alias capaz de ligar cliente a conceito global.

## 16. Cobertura por dimensão

> **Nota R5:** os números herdados desta seção registram a fotografia da R4 e são substituídos, para a R5, pela matriz final do §24.11. A R5 não usa percentuais de completude para universos abertos.

**Métrica:** “conceitos v1” conta apenas códigos canônicos propostos acima, não entradas importadas nem conceitos confirmados. Para dimensão aberta não existe percentual honesto. A revisão de universos finitos pede manifesto da edição e conferência de contagem/integridade na TAX-03/TAX-04. Cobertura operacional de fontes e acurácia de classificador **não foram medidas** nesta TAX-02.

| Dimensão | Universo conhecido | Fonte oficial | Conceitos v1 | Cobertura desta entrega | Lacunas detectáveis |
|---|---|---|---:|---|---|
| Espécie/tributo | competências/espécies constitucionais delimitáveis; exações concretas temporais | CF, CTN, LC214 e leis próprias | 5 espécies + 43 tributos/famílias/competências | estrutural inicial, **não exaustivo** | varredura jurídica por artigos/ente; candidatos de tributo histórico e contribuições específicas |
| Tema e tratamento | aberto | CTN, CF, leis específicas; sem catálogo único | 44 temas + 12 tratamentos | parcial | `UNMAPPED` de termos legais, termos polissêmicos, corpus amostrado |
| Regime | aberto/temporal | LC123, LC214, Receita e leis específicas | 19 | parcial | regimes aduaneiros/especiais, períodos e subtipos |
| Operação/facetas/CFOP | operações econômicas abertas; CFOP finito por edição e escopo fiscal | CF/CTN, NBS, SINIEF/CFOP, DF-e e normas por tributo | 150 operações + 3 âmbitos + 10 finalidades + 3 canais + 1 tipo CFOP; 0 CFOP copiados | semente multissetorial **parcial**; código fiscal somente por vínculo | operações raras, composição de etapas, triangulação, finalidade/titularidade ambígua |
| Documento fiscal | modelos oficiais enumeráveis por sistema/ente/edição | CONFAZ/ENCAT, NFSE, DeRE e entes | 13 | núcleo federal/DF-e, **parcial** | confrontar todos modelos e legados por edição/UF, NFS-e local |
| Obrigação/plataforma | aberto por ente e tempo | SPED, DCTF, ESOC, DeRE, estados/municípios | 23 obrigações/módulos + 2 plataformas | federal ampliado (Simples, RFB, comércio exterior) e exemplos estaduais, **parcial** | inventário UF/município e dever por sujeito/período |
| Atividade CNAE | 1.332 subclasses na edição 2.3; demais níveis oficiais | IBGE/CONCLA | 1 tipo de referência; 0 subclasses copiadas | estrutura de vínculo, **não catálogo carregado** | correspondências históricas, notas e atualização de edição |
| Segmento | aberto | sem catálogo oficial único; CNAE só referência | 45 | semente multissetorial ampliada, **parcial** | segmentos transversais que podem ser faceta/sujeito, limiares de frigorífico, setores ainda ausentes |
| Produto/NCM/NBS | produtos e ofertas abertos; NCM/NBS finitas por edição | Receita/Classif e MDIC/RFB | 188 produtos/famílias + 1 tipo NCM; 0 códigos NCM/NBS copiados | semente multissetorial ampliada, **parcial**; códigos externos apenas por vínculo | apresentação/formulação, famílias ausentes, serviços/intangíveis, edições e códigos válidos por data |
| Sujeito | aberto por papel e tributo | CTN, leis, DF-e | 26 | inicial ampliado, **parcial** | papéis de plataformas, mandatário, sucessor, beneficiário final e condições legais de formas jurídicas |
| Evento/tipo de ato | aberto por ente/formato | atos oficiais; CF/CONFAZ | 13 eventos + 8 tipos | inicial, **parcial** | eventos compostos, força normativa e atos locais |
| Impacto potencial | aberto | vocabulário TriBusca e documentos oficiais | 10 operacionais + 9 sistêmicos | inicial, **parcial** | processos setoriais, siglas e fornecedores distintos |
| Vigência/tempo | tipos de fato finitos na proposta; valores/condições abertos | ato e dispositivo oficiais | 0 tags; esquema de 8 classes de fato | **estruturalmente coberto**, a validar | casos de retroação/parcialidade/condição não testados em corpus |
| Relações entre atos | tipos abertos; identidade de atos ilimitada | atos e dispositivos oficiais | 0 tags; 9 arestas tipadas | **estruturalmente coberto**, a validar | citações sem alvo, consolidação, revogação tácita |
| Esfera/jurisdição/órgão | quatro esferas funcionais; 27 UFs; municípios/órgãos mutáveis | CF/IBGE/SIORG/entes | 4 esferas + 3 tipos de referência; 0 entradas externas copiadas | estrutura apenas; **depende de TAX-03/04** | municípios extintos/novos, órgãos locais, competência territorial |

**Como detectar lacunas:** extrações sem conceito viram candidato `UNMAPPED` com dimensão, trecho e fonte; candidatos são agrupados por sentido/contexto, não somente pela palavra. Auditoria amostral de normas por esfera, UF, tributo, setor e tempo procura menções **não extraídas**, além das extraídas sem mapeamento. Comparar listas oficiais finitas com manifesto da edição; comparar fontes planejadas com coleta efetiva em métrica separada. Publicar cobertura por ocorrências, conceitos distintos e casos críticos, inclusive abstenção; não usar “Outros”. Nenhuma dessas taxas foi calculada aqui.

## 17. Oito testes de sanidade obrigatórios

Estes são **testes conceituais controlados**, não execução de classificador nem comprovação de incidência real. Cada classificação exigirá trecho oficial, versão e jurisdição em uso futuro. A palavra “se” indica dependência de prova no texto, não inferência automática.

| Caso | Classificação representável | Abstenções/limite |
|---|---|---|
| 1. “Convênio ICMS concede crédito presumido para operações interestaduais com determinado produto.” | `act_type.icms_agreement`, `tax.icms`, `theme.presumed_credit`, possivelmente `treatment.presumed_credit` se concessão efetiva, `operation_scope.interstate`; produto pelo nome efetivo; órgão CONFAZ e entes segundo ato. | Não inventar operação de venda se “operações” não especifica venda; NCM, vigência e produto concreto `UNMAPPED` até texto completo. Convênio não implica aplicação local automaticamente. |
| 2. “Norma municipal altera regra de ISS para software.” | `tax.iss`, `event.amends`, `product.software` ou segmento `sector.software_saas` **apenas se a redação falar do modelo de negócio**, município IBGE, ato A→alvo B, fatos temporais. | ISS representável mesmo sem coleta municipal; serviço da LC 116 e legislação local precisam prova; “software” sozinho não prova CNAE, NCM nem SaaS. |
| 3. “Benefício para estabelecimento frigorífico.” | `sector.meatpacking` quando o termo significa estabelecimento da cadeia de abate/processamento, `theme.tax_benefit`, sujeito/ente se explicitados. | CNAE indeterminado; abatedouro, depósito frio e distribuidor não recebem alias exato. Tributo e tratamento dependem do ato. |
| 4. “Alteração de leiaute da NF-e.” | `document.nfe`, `event.amends` somente se a NT/ato altera leiaute anterior identificável; `impact_operational.fiscal_issuance`, `impact_system.nfe_integration` potenciais. | Não inventar tributo; nota técnica sem alvo pode ser `event.disciplines` ou candidato. Não afirmar mudança em SAP do cliente. |
| 5. “Nova regra de EFD ICMS/IPI.” | `obligation.efd_icms_ipi`, `platform.sped` como relação informativa, eventual `impact_operational.bookkeeping`; ICMS/IPI apenas se dispositivos efetivamente os tratam. | Nome da escrituração sozinho não classifica ambos tributos em todo ato; EFD nunca `document.*`. |
| 6. “Diferimento de ICMS na venda de soja por produtor rural.” | `tax.icms`, `theme.tax_deferral`, `treatment.tax_deferral` se regra concreta, `operation.sale`, `product.soy`, `subject.rural_producer`; território e tempo se houver. | Sem NCM; sem CNAE; “produtor rural” jurídico não identifica estabelecimento real. |
| 7. “Crédito” sem “presumido”. | `theme.assessed_tax_credit` **ou** `theme.input_credit` somente se o contexto provar o sentido; caso contrário `AMBIGUOUS` entre crédito constituído, crédito de entrada ou financeiro. | Proibir `theme.presumed_credit` e `treatment.presumed_credit`; `UNMAPPED`/abstenção se contexto insuficiente. |
| 8. “Soja” sem NCM. | `product.soy`, com evidência textual. | `commodity.ncm_reference = UNKNOWN`; nenhuma atribuição de oito dígitos, nem inferência de regime/tributo. |

**Casos adicionais de fronteira para TAX-03:** (a) “Lei de ISS é citada por decreto” ⇒ `cites`, não `amends`; (b) “NF-e usada por frigorífico que apenas armazena” ⇒ documento e armazenagem, sem abate; (c) “IRRF sobre prestação” ⇒ `tax.ir` + `theme.withholding`, não novo imposto; (d) “regime monofásico de combustíveis” ⇒ tratamento, produto e tributo apenas se explícitos, sem aplicar a qualquer revendedor; (e) ato parcialmente eficaz ⇒ fatos por dispositivo; (f) “SaaS hospitalar” ⇒ software e saúde podem coexistir como assunto, sem presumir CNAE ou benefício de saúde; (g) crédito presumido concedido a segmento com condicionantes ⇒ não afirmar direito de cliente nem classificar toda publicação histórica com regra nova.

| Fronteira adicional de operações | Resultado conceitual esperado |
|---|---|
| “Remessa interestadual para conserto de máquina, com retorno” | `operation.shipment` + `operation_scope.interstate` + `operation_purpose.repair`; `operation.repair` e `operation.return` apenas se execução/retorno descritos; sem inferir venda ou CFOP. |
| “Venda em marketplace com entrega futura” | `operation.sale` ou padrão `operation.future_delivery_sale`, `operation_channel.marketplace`; serviço `operation.marketplace_intermediation` só se intermediação da plataforma estiver no texto. |
| “Barter de grãos por insumos com entrega futura” | `operation.barter` com `product.grains`/insumo identificado, partes, condições e datas; não equiparar automaticamente a permuta simples, venda à ordem ou financiamento. |
| “Importação temporária de máquina e posterior reexportação” | `operation.temporary_importation`, `regime.temporary_admission` se concedido, `operation.reexportation` quando comprovada; máquinas como produto amplo, NCM indeterminado. |
| “Emissão de debênture, pagamento de juros e resgate” | `operation.securities_issue`, `operation.interest_payment`, `operation.investment_redemption` somente nas etapas expressas; imposto, retenção e banco não inferidos. |
| “Serviço SaaS prestado a hospital” | `operation.saas_provision`, sujeito prestador/tomador se explícitos; `sector.health` descreve o hospital apenas quando a norma o trata como categoria, sem presumir benefício, NBS ou ISS local. |
| “Troca de óleo diesel por biodiesel em estoque” | Pode ser `operation.blending` se há mistura física; `operation.exchange` somente se há negócio de permuta; produto e NCM dependem da composição final. |

**Fronteiras adicionais da R2 (frases sintéticas, não normas verificadas):**

| Caso | Representação segura | Abstenção obrigatória |
|---|---|---|
| “Fabricante recolhe lote de baterias de lítio para reciclagem” | `operation.product_recall`, `operation.reverse_logistics` e `product.lithium_batteries` se cada ação consta do texto; reciclagem só quando executada/ordenada. | Não inferir devolução de venda, NCM ou crédito fiscal. |
| “Regra para transporte aéreo de carga de minério de cobre” | `operation.cargo_transport` + modal aéreo como atributo comprovado, `product.copper_ore` e âmbito quando explícito. | Não criar operação combinatória para cada modal; não confundir transportadora com `sector.mining` nem atribuir NCM. |
| “Distribuidora de energia compra transformadores” | `sector.energy` ou `operation.energy_distribution` conforme sujeito/ação comprovados, `operation.purchase`, `product.power_transformers`. | Compra de equipamento não prova geração, transmissão nem benefício setorial. |
| “Hospital encomenda exame a laboratório e compra oxigênio medicinal” | `operation.medical_diagnostics` para a prestação comprovada, `product.medical_oxygen` para compra descrita. | Não transformar medicamento/equipamento em serviço nem inferir ISS, NBS, NCM ou sistemas do hospital. |
| “Operadora antecipa recebíveis de restaurante” | `operation.receivables_anticipation`; `sector.food_service` só para o restaurante se a categoria for relevante ao ato. | Não inferir cessão definitiva, factoring, IOF ou elegibilidade da empresa. |

**Fronteiras adicionais da R3 (frases sintéticas, não normas verificadas):**

| Caso | Representação segura | Abstenção obrigatória |
|---|---|---|
| “Regulamento do split payment para pagamentos com cartão” | `theme.split_payment`, `tax.ibs`, `tax.cbs`; `operation.payment_processing` só se o ato tratar do arranjo. | Não classificar como `theme.withholding` nem afirmar que o fornecedor recebe valor líquido sem o texto. |
| “Varejista lança programa de cashback” | Nenhum `theme.personalized_refund`; no máximo candidato `UNMAPPED` comercial. | Alias “cashback” bloqueado sem IBS/CBS e pessoa física no contexto. |
| “Reoneração gradual da folha em 2026” | `tax.cprb`, `tax.payroll_employer_contribution` e fatos temporais por dispositivo. | Não inferir empresa ou atividade beneficiada. |
| “Venda de barra de ouro a joalheria” | `operation.sale`, `product.gold`; tributo conforme o ato. | `tax.iof` só se o ato qualificar o ouro como ativo financeiro ou instrumento cambial. |
| “Contribuição ao fundo estadual como condição do diferimento de ICMS” | `treatment.tax_deferral` com condição; `tax.state_primary_products_contribution` só se o ato instituir a contribuição do ADCT art. 136. | Não tratar toda contribuição a fundo como tributo novo nem estender a outra UF. |

**Fronteiras adicionais da R4 (frases sintéticas, não normas verificadas):**

| Caso | Representação segura | Abstenção obrigatória |
|---|---|---|
| “Alíquota da Cofins-Importação sobre determinada mercadoria” | `tax.cofins_import`, `theme.tax_rate` e mercadoria apenas se nomeada no texto. | Não classificar `tax.pis_pasep_import` por associação lexical, nem presumir NCM. |
| “Microempreendedor individual solicita enquadramento no Simei” | `subject.mei` para a condição jurídica mencionada; `regime.simei` somente se o texto comprovar a opção ou disciplinar o sistema de recolhimento. | A simples menção a MEI não prova opção vigente pelo Simei nem situação de empresa concreta. |
| “Pedido de restituição apresentado por PER/DCOMP” | `theme.refund`; PER/DCOMP como termo de procedimento candidato, com trecho e fonte para TAX-03. | Não criar `obligation.per_dcomp` nem inferir dever periódico de entrega. |
| “Órgão de prefeitura publica decreto sobre benefício” | Registrar órgão emissor, município, tipo de ato e `theme.tax_benefit` se houver disposição pertinente. | Não classificar o órgão administrativo como pessoa jurídica autônoma, nem presumir imunidade ou elegibilidade do município. |

## 18. Pendências registradas para TAX-03 — auditoria independente

| ID | Risco/gap concreto | Prova/revisão exigida |
|---|---|---|
| G01 | Inventário de tributos pode omitir contribuições e tributos históricos/competências; `tax.cide_fuels`, `tax.corporate_interest_contribution`, `tax.rpps_contribution` precisam base legal específica por subtipo. | Varredura CF arts. 145, 148, 149, 149-A, 153–156-A, 195 e leis vigentes/históricas; matriz de previsto/instituído/aplicável. |
| G02 | Redação/efeitos da reforma e alterações legislativas até 2026 podem invalidar generalizações temporais. | Revisar LC214 compilada e cada dispositivo de transição, incluindo alterações posteriores; testar atos anteriores/atuais/futuros. |
| G03 | “Crédito” pode denotar crédito tributário do CTN, crédito de entrada ou crédito financeiro; `theme.presumed_credit`×benefício, suspensão/diferimento são polissêmicos. | Corpus de positivos/negativos por tributo; testar a separação `theme.assessed_tax_credit`/`.input_credit` e abstenção lexical. |
| G04 | `regime.regular`, `regime.special`, `regime.drawback`, trânsito/admissão temporária carecem de fundamento/edição normativa específica; “regime monofásico” é uso lexical concorrente. | Leis/regulamentos/manuais oficiais e teste de regime vs tratamento; mover/rejeitar código se necessário. |
| G05 | Compra para ativo/uso e comércio eletrônico foram separados em `operation.purchase` + finalidade/canal; ainda há padrões compostos (`operation.installment_sale`, `.free_sample_dispatch`, `.sale_on_order`) e processos (`.inventory_write_off`) cuja tipagem pode ser discutível. Triangulação e venda à ordem não equivalem; CFOP não é sinônimo de operação econômica. | Teste de normalização com normas reais multissetoriais, CFOP/NBS/documentos quando pertinentes, exemplos positivos/negativos e sem inferência automática. |
| G06 | Modelos DF-e e leiautes evoluem; NFS-e local não se reduz ao padrão nacional; documentos legados/auxiliares ausentes. | Conferir Ajuste SINIEF/MOC atual e histórico de **cada** modelo, entes e implantação; separar documento de representação. |
| G07 | Obrigações estaduais/municipais ausentes; `obligation.mit` é módulo e talvez deva ser `module.mit`; `obligation.gia_state` não é obrigação uniforme; DeRE assume papéis de documento e obrigação em atos oficiais distintos. | Inventário por UF/município e período, tipagem plataforma/módulo/declaração/escrituração/arquivo e teste documental DeRE. |
| G08 | Frigorífico, abatedouro, processamento, armazenagem e distribuição se sobrepõem; CNAEs candidatos não são vínculos aprovados. | Ler notas CNAE-Subclasses 2.3 por código, mapear `overlap` com justificativa; testar frases ambíguas e casos avícolas. |
| G09 | Segmentos genéricos “indústria”, “saúde”, “importador”, “e-commerce” podem misturar setor, modelo, papel e canal. | Revisão multissetorial, proposta de facetas se útil, exemplos negativos de setores raros. |
| G10 | Mesmo com 188 conceitos, produtos são universo aberto; “soja” engloba grão, óleo, farelo, semente, e outros nomes variam por forma/edição. Serviços/intangíveis exigem relação NBS própria, não NCM. | Testar amostra por seção NCM e setor, com notas legais/Classif; não aprovar mapeamento exato genérico; decidir cobertura NBS e manter `UNMAPPED` mensurável. |
| G11 | `subject.tax_substitute` como subtipo de responsável e relações IRPF/IRPJ precisam revisão jurídico-semântica; “não contribuinte” precisa tributo expresso. | Parecer jurídico com CTN e leis específicas; rejeitar hierarquia se contraexemplo. |
| G12 | Eventos “restabelece”, “consolida”, “retifica” têm efeitos não triviais; alvo de ato pode ser dispositivo ou versão histórica. | Amostra de atos oficiais com retificação/revogação parcial/sem alvo claro e validação do sentido das arestas. |
| G13 | DRC/J1BTAX/SAP são termos técnicos de contexto; `impact_system.drc` e aliases podem gerar falso positivo; impacto global não prova necessidade privada. | Revisão por especialista de sistemas e fronteira de privacidade; abstenção para siglas. |
| G14 | Fontes oficiais de tributo/localidade/órgão podem mudar e alguns links são páginas compiladas sem edição imutável. | Manifesto por edição, captura/hash de referência se permitido, crosswalk e vigência; SIORG só no escopo federal Executivo. |
| G15 | Taxonomia proposta ainda não foi aplicada a corpus representativo, logo não há recall/precisão ou cobertura real. | Amostra estratificada de normas oficiais por tributo, setor, esfera, tempo e fonte; dupla anotação; medir `UNMAPPED`, ambiguidades, falso negativo e representação. |
| G16 | Alguns exemplos de caso são frases sintéticas e não provam força normativa, órgão/competência ou aplicação local. | Substituir/adicionar atos oficiais reais com trecho, versão, órgão, jurisdição, alvo e data; manter os sintéticos como controle de fronteira. |
| G17 | **R3: tratado em grande parte** — 13 tributos (inclusive folha, CPRB, produtor rural, Sistema S, Cide-Royalties, AFRMM, Condecine, Fust, Funttel, ADCT art. 136, PIS/Cofins-Importação) e 8 regimes (PIS/Cofins cumulativo e não cumulativo, Simei, ZFM, ALC, Reidi, Repetro, Recof). Restam contribuições específicas por entidade do Sistema S, taxas setoriais de fiscalização e CPMF histórica. Texto original: Tributos, contribuições e regimes transversais sem código, de todos os segmentos: contribuições sobre folha (salário-educação, terceiros/Sistema S, RAT, CPRB); contribuições setoriais (Fust, Funttel, Condecine, AFRMM, Cide-Remessas); contribuições previdenciárias do produtor rural/agroindústria e Senar; contribuições estaduais sobre produtos primários e semielaborados (ADCT art. 136, EC 132/2023); regimes PIS/Cofins cumulativo e não cumulativo (citados em `tax.cofins`); MEI/Simei; ZFM/áreas de livre comércio; Reidi, Repetro, Recof e demais regimes setoriais. | Base legal e vigência por item; decidir `tax.*` × `regime.*`; manter candidatos até prova. |
| G18 | **R3: tratado em parte** — 9 temas (split payment, cashback, transição, cesta básica, fundo de compensação, apuração assistida, preços de transferência, transação, consulta) e 3 tratamentos. Restam subtipos dos regimes específicos e das reduções de alíquota da LC 214 e as hipóteses do IS como conceitos próprios. Texto original: Reforma sem código: recolhimento na liquidação financeira (split payment), devolução personalizada (cashback), período de transição, ressarcimento de saldo credor de IBS/CBS, Comitê Gestor/apuração assistida, cesta básica nacional (hoje só via `treatment.zero_rate`); subtipos dos regimes específicos da LC 214 (combustíveis, serviços financeiros, planos de saúde, concursos de prognósticos, bens imóveis, cooperativas, bares e restaurantes, hotelaria, parques, agências de turismo, SAF, missões diplomáticas, entre outros), das reduções de alíquota por setor e das hipóteses do Imposto Seletivo (veículos, embarcações, aeronaves, fumígenos, bebidas alcoólicas e açucaradas, bens minerais, prognósticos). | Conferir LC214 compilada por dispositivo; decidir `theme.*` × `treatment.*` × `regime.*`; exemplos positivos/negativos por setor. |
| G19 | **R3: tratado em grande parte** — 12 obrigações mantidas e 2 documentos novos. Resta confirmar edição e obrigados de cada um. Texto original: Documentos e obrigações ausentes de vários segmentos: NFA-e avulsa, nota fiscal de produtor rural; PGDAS-D/Defis (Simples), PER/DCOMP, DIRBI, e-Financeira (financeiro), DIMP (meios de pagamento), DMED (saúde), DIMOB e DOI (imobiliário/cartórios), DUIMP e DU-E (comércio exterior), DIRF (histórica). | Inventário por ato/edição, esfera e UF; separar documento, declaração e módulo. |
| G20 | Eventos `suspends`, `reinstates`, `postpones`, `corrects`, `institutes` e `clarifies` não têm tipo de aresta entre atos (§14). | Decidir se cada evento gera aresta própria ou só fato temporal; testar com atos reais. |
| G21 | Sobreposições remanescentes: `operation.transport_service` × filhos de transporte; `operation.loan_of_fungibles` × `operation.loan_granting`; `impact_operational.tax_master_data` × `impact_system.tax_master_data`; `operation.customs_transit` × `regime.customs_transit`. | Decidir fusão, hierarquia ou manutenção com critério de fronteira documentado. |
| G22 | **R3:** planos de saúde, bebidas, fumo e esporte/SAF viraram segmentos; setor público virou `subject.public_entity`, seguindo o critério da R2 para cooperativa. Texto da R2: Parcialmente tratado na R2: agora há 41 segmentos e 188 produtos com mineração, óleo/gás, química, farmacêutica, automotiva, metalurgia, papel, têxtil, seguros, imobiliário, turismo, alimentação, saneamento, mídia, apostas, aviação e portos; tabaco, armas, ouro e minerais ganharam conceitos de produto. Cooperativa e entidade sem fins lucrativos foram colocadas em `subject.*` por serem tipos de sujeito transversais, não segmentos. Ainda faltam ou exigem fronteira melhor: bebidas/fumo como segmentos, planos de saúde, setor público, esporte/SAF e vários serviços/mercadorias. | Amostrar seções da CNAE e setores da LC 214 sem copiá-los; rever cada novo conceito com +/− em atos reais e manter `UNMAPPED` para lacunas. |
| G23 | Ampliação R2 cria fronteiras novas: logística reversa × devolução; recolhimento × destinação de resíduos; perda física × baixa contábil; fornecimento × geração/transmissão/distribuição/comercialização de energia; seguro × resseguro; antecipação de recebíveis × cessão/factoring; produtos químicos e minerais próximos; livro digital × mercadoria NCM. | Provar separabilidade em atos oficiais de diferentes setores, edição e jurisdição; rejeitar ou fundir conceito sem ganho semântico; não atribuir incidência, benefício, CNAE, NCM, NBS ou CFOP por similaridade lexical. |
| G24 | Fronteiras criadas pela R3 ainda abertas: natureza jurídica de Fust, Funttel, AFRMM e Condecine (Cide ou outra espécie); `document.nfae` como subtipo documental ou atributo de emissão da NF-e modelo 55; `tax.state_primary_products_contribution` × contribuição exigida como condição de benefício de ICMS; ouro mercadoria × ativo financeiro; `sector.beverages` × `product.sweetened_beverages` × IS. A R4 já retirou PER/DCOMP de `obligation.*`, mas sua futura dimensão de procedimento segue indecidida. | Parecer jurídico/documental por item e teste com atos reais de cada setor; decidir a tipagem NFA-e e de procedimento sem inferência automática. |
| G25 | Fronteiras verificadas pontualmente na R4: PIS/Pasep-Importação e Cofins-Importação têm identidades separadas; MEI é sujeito/enquadramento e Simei é opção de recolhimento; órgão administrativo e pessoa jurídica pública não são sinônimos. Permanecem sem auditoria sistemática as condições de aplicação, vigência histórica e eventuais aliases desses conceitos, bem como a nota fiscal de produtor modelo 04 por UF/edição. | TAX-03 deve testar os códigos corrigidos em atos reais de períodos distintos, conferir a edição normativa do modelo 04 por ente, aprovar ou rejeitar hierarquias/aliases e registrar contraexemplos. |

### Recomendação operacional da TAX-03

Auditar **todas** as linhas propostas contra fonte primária e corpus heterogêneo, priorizando G01–G08 e erros que poderiam afirmar direito/obrigação indevidos. Congelar versão desta TAX-02, registrar correções como diff de conceito/alias/relação, e produzir parecer por dimensão: `APPROVE`, `REVISE` ou `REJECT`, com exemplos reproduzíveis. Validar separadamente três camadas de cobertura: universo oficial indexável, capacidade semântica de representar normas, e coleta efetiva de fontes. A TAX-03 deve auditar também dados de fontes não presentes na lista inicial; a lista de setores desta v1 não define universo completo. Nenhum resultado semântico aqui autoriza migration, IA, matching ou exposição pública.

### Perguntas realmente bloqueantes

**Nenhuma decisão de produto bloqueia o início da TAX-03.** A auditoria pode decidir tecnicamente as tipagens, aliases, hierarquias e lacunas acima. Para uma **aprovação final implementável** antes da TAX-04 será preciso designar aprovador jurídico/curador e fixar manifesto de edições oficiais e critérios de aceitação do corpus; isto é um gate posterior, não motivo para apresentar este dicionário como completo.

## 19. Registro de conclusão

A v1 é **proposta funcional para auditoria**: ISS está representado; frigorífico está separado de CNAE e de atividades vizinhas; produto está separado de NCM; tributo, tema, operação, segmento, documento e obrigação possuem códigos e contraexemplos; histórico/tempo e `UNMAPPED` são requisitos explícitos. Não houve modelagem PostgreSQL, importação CNAE/NCM, coleta, classificação automática, matching ou alteração de dados de produção. Aprovação de TAX-01 não implica aprovação automática das linhas de TAX-02.


## 20. Registro de revisão R1 (28/09/2026)

Este quadro registra o que a R1 alterou em relação ao rascunho inicial. Onde a R2 fizer nova correção, vale o contrato e a redação vigente acima, com o delta explicitado no §21.

Correções de consistência aplicadas pela R1 antes da TAX-03. Naquele momento nenhum conceito novo foi criado e a R1 continha 456 linhas; as contagens vigentes desta R2 estão no §16. Como todos os registros ainda são `proposed`, os renomes abaixo não violam a regra de estabilidade de código.

| Tipo | Antes | Depois | Motivo |
|---|---|---|---|
| Renome | `sector.meat_processing` | `sector.meatpacking` | Código sugeria “processamento de carnes”, rótulo de `sector.meat_products`. |
| Renome | `theme.suspension` | `theme.tax_suspension` | Simetria com `treatment.tax_suspension`, como em diferimento/ST. |
| Renome | `operation.corporate_merger` / `operation.corporate_acquisition` | `operation.corporate_consolidation` / `operation.corporate_incorporation` | “Acquisition” não significa incorporação (LSA art. 227); fusão é art. 228. |
| Renome | `operation.origin` / `operation.destination` | `jurisdiction.operation_origin` / `jurisdiction.operation_destination` | Prefixo `operation` é reservado a ações; são papéis territoriais. |
| Renome | `operation.cfop_reference` | `fiscal_code.cfop_reference` | Idem; alinha com `activity.*`/`commodity.*` de referência. |
| Correção | `authority.siorg_reference` | `authority.official_body_reference` | Dois nomes para o mesmo tipo de referência. |
| Correção | `impact_system.fiscal_issuance` (§13) | `impact_operational.fiscal_issuance` | Código citado não existia. |
| Correção | `tax.ir`: “retenção é tratamento” | retenção é `theme.withholding` | Não existe `treatment.withholding`; caso (c) do §17 já usa tema. |
| Correção | `pai`/`rel` divergentes | `pai:` em beef, poultry_meat, pork, diesel, gasoline, repeals_partially | §15 declarava hierarquia que a linha não tinha; pork incluído por coerência com beef. |
| Correção | Âncoras fora da matriz; tipo `T` com fonte oficial | §3.1 + regra de tipo no §1; theme.tax_deferral/anticipation → `H`; Cide → L10336; DIFAL → CF/LC190; mútuo → CC; societárias → LSA | Contrato do §1 exige chave na matriz. |
| Correção | Metadado “dimensão = título da tabela” | dimensão = prefixo do código | Tabelas não têm título e o §7 mistura facetas. |
| Correção | 4 facetas dentro da tabela de operações | movidas para §7.6; frase de histórico removida | Coerência com o próprio §7. |
| Correção | DeSTDA sem sujeito | optantes do Simples Nacional, Ajuste SINIEF 12/2015 | Definição omitia o escopo. |
| Correção | Aliases “Abatedouro”, “Crédito”, “ITCD” | alvo slaughterhouse; sem alvo único; `JURISDICTIONAL_LABEL` | “Crédito” apontava justamente para o conceito que o caso 7 proíbe; ITCD é nome vigente em UFs. |
| Inclusão | — | alias “IE” `AMBIGUOUS`; lista fechada de relações (§15); CNAEs de matadouro sob contrato; G17–G22 (lacunas de todos os segmentos) | Lacunas encontradas na revisão. |
| Texto | “retensão”; rótulo “Corretivo de solo” | “retenção”; “Calcário agrícola (corretivo de solo)” | Grafia; rótulo mais amplo que o código. |

## 21. Registro de revisão R2 (28/09/2026)

Esta revisão preserva a R1 como histórico de entrada e mantém **todos os conceitos em `proposed`**. Foram adicionados **118 códigos canônicos**: 41 operações (§7.7), 17 segmentos (§10.2.1), 58 produtos (§10.3.1) e 2 sujeitos (§11). O dicionário contém agora **574 linhas canônicas únicas**. Os números não incluem códigos externos CNAE/NCM/NBS/CFOP, tipos de referência descritos em prosa nem arestas entre atos; os totais por dimensão estão no §16.

| Correção ou complemento | Resultado e limite |
|---|---|
| Contrato de relações | §1/§15 deixam de chamar a lista da R1 de fechada; `part_of`, `replaced_by`, `supersedes` e `applies_to` da TAX-01 permanecem disponíveis, ainda que sem aresta de exemplo nesta semente. `about`, `hosted_by` e `fulfills` ficam explicitamente propostos para TAX-03. |
| Aliases | `JURISDICTIONAL_LABEL` fica como refinamento candidato, dependente de auditoria, sem suprimir as cinco classes da TAX-01. |
| Fontes | §3 distingue fontes da matriz principal consultadas de chaves adicionadas sem verificação na R1; §3.2 registra páginas primárias reconferidas nesta R2. 16 linhas de segmento que diziam `TriBusca/CNAE·T` passaram a `TriBusca·T`, pois CNAE não define o conceito comercial nem foi mapeada a ele. |
| Ampliação de operações | 41 ações de circulação reversa, agroindústria, mineração, energia, portos, serviços, saúde, imóveis e finanças com definição e +/−. Operação não vira CFOP, incidência ou ato efetivo do cliente. |
| Nomes societários | `operation.corporate_consolidation` (R1) virou `operation.corporate_fusion`; `operation.corporate_incorporation` virou `operation.corporate_absorption`. Os novos códigos distinguem fusão jurídica de consolidação contábil e incorporação societária de constituição de empresa; arts. 227–228 da LSA. Como nenhum código foi aprovado/publicado, não há migração histórica. |
| Ampliação de produtos | 58 mercadorias/famílias de mineração, químicos, combustíveis, saúde, têxtil, máquinas, veículos, tabaco, armas e publicações com definição e +/−. Produtos podem atravessar múltiplas posições NCM; nenhuma correspondência de oito dígitos foi inventada. |
| Ampliação de segmentos e sujeitos | 17 famílias multissetoriais com +/−, sem equiparar CNAE a segmento. Cooperativa e entidade sem fins lucrativos foram registradas em `subject.*` por serem tipos de sujeito transversais; regime e imunidade continuam condicionados à norma. |
| Cobertura e sanidade | §16 foi recalculado, §17 recebeu cinco novos casos de fronteira; G10/G22 foram atualizados e G23 registra sobreposições novas a auditar. A expansão não afirma cobertura exaustiva, acurácia de classificador nem aprovação jurídica. |

**Gate para TAX-03:** revisar fontes ainda pendentes, testar os 118 registros novos em normas oficiais reais e amostra de diferentes setores, decidir fusões/mudanças de dimensão, e aprovar ou rejeitar especializações de relações/alias. Nenhum dado de empresa, cliente ou operação real foi usado para criar estes conceitos.


## 22. Registro de revisão R3 (28/09/2026)

Esta revisão parte da R2 sem desfazer nada dela e mantém **todos os conceitos em `proposed`**. Foram adicionados **55 códigos canônicos**: 13 tributos, 9 temas, 3 tratamentos, 8 regimes, 2 documentos, 13 obrigações, 4 segmentos e 3 sujeitos. Na R3, o dicionário tinha **629 linhas canônicas únicas**; a contagem vigente da R4 está no §23.

| Correção ou complemento | Resultado e limite |
|---|---|
| Núcleo tributário | A R2 ampliou só operações, segmentos e produtos; tributos, temas e obrigações continuavam iguais à R1. A R3 cobre as pendências G17–G19, que valem para todos os segmentos. |
| Fontes verificadas | Conferidos na fonte primária: LC 214, arts. 31–35 (split payment); Lei 14.973/2024, art. 43 (declaração de benefícios) e reoneração da CPRB em 2025–2027. As demais chaves de §3.3 continuam com consulta pendente. |
| Âncoras | Conceitos com definição legal que a R2 marcou `TriBusca·T` passaram a `H`: cooperativa (Lei 5.764), entidade sem fins lucrativos (CF/CTN), resseguro (LC 126), previdência complementar (LC 109), ativos virtuais (Lei 14.478), livros e jornais (CF). |
| Ouro | `product.gold` recebeu o alerta do CF art. 153, §5º: ouro ativo financeiro sujeita-se só ao IOF. A R2 não distinguia mercadoria de ativo financeiro. |
| Hierarquias | `product.aviation_gasoline` e `product.lithium_batteries` passaram de `rel:` a `pai:`, pelo mesmo critério da R1 para carnes e combustíveis; §15 lista as hierarquias novas. |
| Aliases | Funrural, Sistema S, desoneração da folha, split payment e cashback; “cashback” fica `AMBIGUOUS` por homonímia com programa comercial. |
| Sanidade e pendências | §17 recebeu cinco casos de fronteira da reforma e da folha; G17–G19 e G22 foram atualizados e G24 registra as fronteiras novas. |

**Gate para TAX-03:** conferir as chaves de §3.3 ainda pendentes, testar os 55 registros novos em atos oficiais e decidir G24.

## 23. Registro de revisão R4 (28/09/2026)

A R4 preserva a R3 como documento de entrada e mantém **todas as linhas em `proposed`**. A contagem vigente é **630 códigos canônicos únicos**: 43 `tax`, 5 `tax_species`, 44 `theme`, 12 `treatment`, 19 `regime`, 150 `operation`, 188 `product`, 45 `sector`, 26 `subject`, 23 `obligation`, 13 `document` e as demais dimensões discriminadas no §16. O ganho líquido de uma linha resulta de separar duas contribuições que a R3 unia e de retirar PER/DCOMP da dimensão de obrigação, compensado por `subject.mei`. Os códigos da R3 ainda não tinham sido aprovados/publicados; a lista de renomes e retiradas abaixo deve acompanhar qualquer futura comparação de versões, sem reescrever classificações históricas que venham a existir.

| Correção | Antes na R3 | Depois na R4 | Razão e limite |
|---|---|---|---|
| Tributos de importação | `tax.pis_cofins_import` | `tax.pis_pasep_import` e `tax.cofins_import` | A Lei 10.865/2004 institui duas contribuições; menção a uma não comprova a outra. A transição tributária precisa ser aferida por dispositivo/data. |
| MEI e Simei | `regime.mei` para status e recolhimento | `subject.mei` e `regime.simei` | LC 123/2006, art. 18-A, separa condição de MEI da opção pelo sistema de recolhimento. Relação informativa, sem propagação. |
| PER/DCOMP | `obligation.per_dcomp` | Sem código canônico por ora; candidato de procedimento | A Receita descreve pedido/declaração conforme a finalidade. Um pedido facultativo não é automaticamente obrigação acessória periódica; `theme.refund` e `theme.offset` continuam disponíveis. A dimensão processual fica para TAX-03. |
| NFA-e | Documento aparentemente autônomo | Variante da NF-e modelo 55, com `pai: document.nfe` **proposto** | O MOC descreve a emissão avulsa em sistema da administração. TAX-03 deve decidir se permanece subtipo ou atributo de emissão; não contar como novo modelo fiscal. |
| Nota de produtor | Modelo 04 ou eletrônico na mesma definição | `document.rural_producer_invoice` restrito ao modelo 04 | NF-e modelo 55 de produtor não equivale automaticamente ao modelo 04; vigência/substituição dependem de UF e edição. |
| DIRF | “histórica” sem corte preciso | Linha temporal para fatos desde 01/01/2025 e ressalva de períodos anteriores | Evita declarar DIRF corrente para fatos novos ou eliminar retificações históricas. |
| Sujeito público | Órgão como exemplo de pessoa jurídica | Município/autarquia como exemplos; órgão emissor em `authority.*` | Pessoa jurídica, órgão administrativo e imunidade não são equivalentes. |
| Prova conceitual | Sem controles para estes erros | Quatro casos adicionais no §17 e gaps G24–G25 atualizados | Testam separação de tributos, regime/sujeito, procedimento/obrigação e órgão/ente; continuam sintéticos. |

**Verificação da edição:** 630 registros, 630 códigos distintos, zero linha canônica sem exemplo positivo/negativo e zero linha canônica com colunas malformadas. Essa checagem prova consistência estrutural do arquivo, **não** validade jurídica de cada proposta. A reconferência oficial pontual consta do §3.4. Persistem a auditoria jurídica integral, a checagem de edições e vigência das chaves de fonte, a revisão de hierarquias/aliases e o teste em corpus real previstos na TAX-03. Nenhum CNAE, NCM, CFOP, benefício ou efeito para cliente foi inferido destas correções.

## 24. Revisão R6 — correção incremental pós-TAX-03-R5 (29/09/2026)

### 24.1 Estado, método e limites

A R6 trata exclusivamente os bloqueios B1–B4 da revisão independente TAX-03-R5, preservando os pontos materiais aprovados e sem alterar TAX-01, R3, R4 ou o roteiro TAX-03. Todos os conceitos continuam `proposed`. `UNMAPPED`, `AMBIGUOUS`, `NEEDS_EVIDENCE` e abstenção continuam resultados válidos. Frase sintética serve para fronteira semântica; **não** substitui prova jurídica. Universo de produto, operação, tema e segmento continua `open universe`.

Separação obrigatória preservada: conceito ≠ menção; conceito ≠ classificação; classificação ≠ cobertura; taxonomia global ≠ relevância privada; segmento ≠ CNAE; produto ≠ NCM; documento fiscal ≠ obrigação; tributo ≠ tratamento/tema; evento normativo ≠ tipo de ato; cobertura conceitual ≠ cobertura dos conectores. Nenhuma relação propaga classificação automaticamente.

### 24.2 Decisões bloqueantes

| Tema | Decisão R5 | Evidência/limite |
|---|---|---|
| MIT | **REMOVE do catálogo canônico nesta revisão:** `platform.mit` é retirado. | A RFB descreve MIT como **serviço integrado à DCTFWeb** e também como **nova escrituração geradora da DCTFWeb**. As dimensões atuais não o representam sem conflar obrigação, plataforma e escrituração. R6 registra MIT como `UNMAPPED_DIMENSION` e propõe, para decisão de governança, extensão `bookkeeping` (candidato futuro `bookkeeping.mit`) antes da TAX-04. |
| NFA-e | **REMOVE como conceito canônico:** `document.nfae` → propriedade de emissão de `document.nfe`. | MOC NF-e 7.0: NFA-e é NF-e **modelo 55** emitida em sistema do Fisco; `serie` e `procEmi` distinguem o processo. |
| Nota Fiscal de Produtor | **KEEP restrito ao modelo 04.** | MOC NF-e 7.0 e normas estaduais demonstram substituição por NF-e 55 conforme UF/período. NFP-e/NF-e 55 não é sinônimo do modelo 04. |
| Alias ITCD | **Não criar `JURISDICTIONAL_LABEL`.** | Usar `ABBREVIATION` + jurisdição/edição no vínculo. A TAX-01 não aprovou sexta classe de alias. |
| 66 âncoras genéricas R4 | **REVIEWED + rastreabilidade corrigida em R6.** | Toda ocorrência canônica de `lei específica`/`ato oficial` permanece retirada; `RICMS-MT-R5` foi substituída por `RICMS-MT-ST-R6` e `UF-R5` por `GO-NFE-R6`/`MOC-NFE-R5`. |

### 24.3 Manifesto de fontes e edições R6

**Consulta complementar R6:** 29/09/2026. As fontes herdadas da R5 permanecem abaixo; as cinco chaves R6 adicionadas corrigem B1–B3. URL de portal é índice; quando a classificação depende de regra jurídica, o vínculo deve registrar ato/dispositivo/edição aplicável. Página compilada não deve ser tratada como versão imutável.

| Chave R5 | Mantenedor / ato / edição | Dispositivo ou escopo | Período/limite | URL oficial |
|---|---|---|---|---|
| CF-R5 | Presidência/Planalto; Constituição compilada | arts. 145, 148, 149, 149-A, 153–156-A, 195 e ADCT conforme conceito | redação por data | https://www.planalto.gov.br/ccivil_03/constituicao/constituicaocompilado.htm |
| CTN-R5 | Presidência/Planalto; Lei 5.172/1966 compilada | obrigação, crédito, arts. 121 e 128 para sujeito/responsabilidade | regra geral; lei específica pode qualificar | https://www.planalto.gov.br/ccivil_03/leis/l5172compilado.htm |
| LC214-R5 | Presidência/Planalto; LC 214/2025 compilada com LC 227/2026 | IBS/CBS/IS; arts. 27 e 31–35 split payment; arts. 112–124 cashback; regimes por dispositivo | produção de efeitos deve ser lida por artigo | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214compilado.htm |
| LC227-R5 | Presidência/Planalto; LC 227/2026 | alterações da LC 214 e disciplina complementar | alterações posteriores à redação original da LC 214 | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp227.htm |
| LC116-R5 | Presidência/Planalto; LC 116/2003 compilada | ISS e lista nacional, inclusive serviços de informática | lei municipal continua necessária | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp116.htm |
| LC123-R5 | Presidência/Planalto; LC 123/2006 | art. 18-A; MEI/Simei | opção/enquadramento por período | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp123.htm |
| LC190-R5 | Presidência/Planalto; LC 190/2022 | DIFAL ICMS não contribuinte | ler com CF/EC 87 e período | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp190.htm |
| L10336-R5 | Presidência/Planalto; Lei 10.336/2001 | CIDE-Combustíveis | hipóteses/produtos por redação vigente | https://www.planalto.gov.br/ccivil_03/leis/leis_2001/l10336.htm |
| CC-R5 | Presidência/Planalto; Lei 10.406/2002 | contratos civis, inclusive mútuo/comodato | contrato ≠ incidência tributária | https://www.planalto.gov.br/ccivil_03/leis/2002/l10406compilada.htm |
| L8212-R5 | Presidência/Planalto; Lei 8.212/1991 | custeio, contribuição patronal/RAT/produtor rural | sujeito/base por dispositivo | https://www.planalto.gov.br/ccivil_03/leis/l8212cons.htm |
| L12546-R5 | Presidência/Planalto; Lei 12.546/2011 | CPRB, arts. 7º–9º-A | transição/reoneração exige edição | https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2011/lei/l12546.htm |
| L9718-R5 | Presidência/Planalto; Lei 9.718/1998 | PIS/Cofins cumulativos | regime e período | https://www.planalto.gov.br/ccivil_03/leis/l9718compilada.htm |
| L10637-R5 | Presidência/Planalto; Lei 10.637/2002 | PIS/Pasep não cumulativo | crédito por hipótese legal | https://www.planalto.gov.br/ccivil_03/leis/2002/l10637.htm |
| L10833-R5 | Presidência/Planalto; Lei 10.833/2003 | Cofins não cumulativa | crédito por hipótese legal | https://www.planalto.gov.br/ccivil_03/leis/2003/l10.833.htm |
| L10865-R5 | Presidência/Planalto; Lei 10.865/2004 | art. 1º: PIS/Pasep-Importação e Cofins-Importação separados | transição por dispositivo | https://www.planalto.gov.br/ccivil_03/_ato2004-2006/2004/lei/l10.865.htm |
| L10168-R5 | Presidência/Planalto; Lei 10.168/2000 | CIDE em remessas/tecnologia conforme hipótese | não confundir com IRRF | https://www.planalto.gov.br/ccivil_03/leis/l10168.htm |
| L10893-R5 | Presidência/Planalto; Lei 10.893/2004 | AFRMM | natureza/hipótese por dispositivo | https://www.planalto.gov.br/ccivil_03/_ato2004-2006/2004/lei/l10.893.htm |
| MP2228-R5 | Presidência/Planalto; MP 2.228-1/2001 | CONDECINE | modalidades/hipóteses por edição | https://www.planalto.gov.br/ccivil_03/mpv/2228-1.htm |
| L9998-R5 | Presidência/Planalto; Lei 9.998/2000 | FUST | setor telecom; contribuinte não decorre só do segmento | https://www.planalto.gov.br/ccivil_03/leis/l9998.htm |
| L10052-R5 | Presidência/Planalto; Lei 10.052/2000 | FUNTTEL | hipótese/contribuinte por dispositivo | https://www.planalto.gov.br/ccivil_03/leis/l10052.htm |
| DL288-R5 | Presidência/Planalto; DL 288/1967 | Zona Franca de Manaus | benefício/regime depende da operação | https://www.planalto.gov.br/ccivil_03/decreto-lei/del0288.htm |
| L11488-R5 | Presidência/Planalto; Lei 11.488/2007 | REIDI | construção/infraestrutura; habilitação e condições | https://www.planalto.gov.br/ccivil_03/_ato2007-2010/2007/lei/l11488.htm |
| L14596-R5 | Presidência/Planalto; Lei 14.596/2023 | preços de transferência | não é tributo novo | https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2023/lei/l14596.htm |
| L13988-R5 | Presidência/Planalto; Lei 13.988/2020 | transação tributária | procedimento/tema, não tributo | https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2020/lei/l13988.htm |
| L5764-R5 | Presidência/Planalto; Lei 5.764/1971 | cooperativas/ato cooperativo | tipo de sujeito ≠ imunidade | https://www.planalto.gov.br/ccivil_03/leis/l5764.htm |
| LC109-R5 | Presidência/Planalto; LC 109/2001 | previdência complementar | setor/regulação ≠ tratamento fiscal automático | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp109.htm |
| LC126-R5 | Presidência/Planalto; LC 126/2007 | resseguro | versão alterada deve ser qualificada | https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp126.htm |
| L14478-R5 | Presidência/Planalto; Lei 14.478/2022 | ativos virtuais | regulação do prestador ≠ incidência tributária | https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2022/lei/l14478.htm |
| L9656-R5 | Presidência/Planalto; Lei 9.656/1998 | planos de saúde | setor/regime, sem inferir tributo | https://www.planalto.gov.br/ccivil_03/leis/l9656.htm |
| L14193-R5 | Presidência/Planalto; Lei 14.193/2021 | SAF | edição posterior deve ser qualificada | https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14193.htm |
| SISCOMEX-R5 | Governo Federal; Portal Único Siscomex | DUIMP, DU-E e procedimentos aduaneiros | cronograma/implantação por edição | https://www.gov.br/siscomex/pt-br |
| RFB-DCTFWEB-R5 | Receita Federal; DCTFWeb/MIT | MIT como serviço integrado à DCTFWeb | desde 01/01/2025 para débitos migrados; escopo por orientação/ato | https://www.gov.br/pt-br/servicos/declarar-debitos-e-creditos-previdenciarios-e-de-outras-entidades-e-fundos |
| RFB-PERDCOMP-R5 | Receita Federal; PER/DCOMP; IN RFB 2.055/2021 referenciada na orientação vigente | pedido de restituição/ressarcimento/reembolso ou declaração de compensação | procedimento conforme crédito; formulário/vedações conforme dispositivo da IN | https://www.gov.br/receitafederal/pt-br/canais_atendimento/fale-conosco/perdcomp |
| MOC-NFE-R5 | ENCAT/CONFAZ; MOC NF-e 7.0 | NF-e 55; NFA-e como NF-e 55; séries/processo; substituição do modelo 04 | edição 7.0; NTs podem alterar leiaute | https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-visao-geral.pdf |
| MOC-NFE-LAYOUT-R5 | ENCAT/CONFAZ; MOC NF-e 7.0 Anexo I | leiaute/regras, inclusive referência a NF de Produtor modelo 04 | edição do MOC/NT | https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-anexo-i-leiaute-e-rv.pdf |
| NFE-NT-R5 | Portal NF-e/ENCAT; notas técnicas vigentes | alterações de leiaute, inclusive RTC | cada NT tem versão/data própria | https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY= |
| SPED-EFD-R5 | Receita Federal/SPED; Guia EFD ICMS/IPI | obrigação/escrituração, versão 3.2.x em 2026 | usar versão publicada aplicável | https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-icms-ipi |
| CNAE-R5 | IBGE/CONCLA; CNAE 2.0/2.3 | frigorífico, abatedouro, fabricação de carne; atividade ≠ segmento | edição/código precisam acompanhar vínculo | https://concla.ibge.gov.br/busca-online-cnae.html |
| RICMS-MT-ANEXO-VI-R5 | SEFAZ-MT; Decreto 2.212/2014, Anexo VI art. 6º | crédito presumido interestadual de carnes para CNAEs de abatedouro/frigorífico | percentual/condições por redação vigente | https://www.sefaz.mt.gov.br/legislacao/SubIndice.aspx?ID=190 |
| RICMS-MT-ANEXO-VII-R5 | SEFAZ-MT; Decreto 2.212/2014, Anexo VII art. 7º | diferimento de soja e condições | opção/regularidade/interrupção por período | https://www.sefaz.mt.gov.br/legislacao/ |
| GO-NFE-R5 | Secretaria da Economia-GO | NF-e 55 em substituição à Nota Fiscal de Produtor modelo 4 | disciplina estadual; consultar edição do RCTE | https://goias.gov.br/economia/nf-e-nota-fiscal-eletronica/ |
| GOIANIA-CTM-R5 | Prefeitura de Goiânia; LC 344/2021 + alterações | ISS e lista municipal; software em item de serviços | vigência local; alterações posteriores | https://www.goiania.go.gov.br/sefaz/atos-e-normas/ |
| GOIANIA-DEC-R5 | Prefeitura de Goiânia; Decreto 2.824/2025 | SGISS e documentos/declarações municipais | operação local; não extrapolar para outros municípios | https://www.goiania.go.gov.br/html/gabinete_civil/sileg/dados/legis/2025/dc_20250825_000002824.html |
| CONFAZ-R5 | CONFAZ | convênios, ajustes SINIEF, protocolos | incorporação/efeitos por ato/UF quando aplicável | https://www.confaz.fazenda.gov.br/legislacao |
| RFB-MIT-R6 | Receita Federal; serviço DCTFWeb/MIT e esclarecimento oficial de 17/12/2024 (atualizado 30/04/2025) | MIT como serviço integrado à DCTFWeb e como nova escrituração geradora de DCTFWeb; não prova obrigação autônoma nem dimensão `platform` | fatos geradores desde 01/01/2025; consulta em 29/09/2026 | https://www.gov.br/pt-br/servicos/declarar-debitos-e-creditos-tributarios-federais ; https://www.gov.br/esocial/pt-br/noticias/receita-federal/receita-federal-divulga-esclarecimentos-iniciais-sobre-a-substituicao-da-dctf-a-partir-de-janeiro-de-2025 |
| RICMS-MT-ST-R6 | SEFAZ-MT; RICMS/2014, Decreto 2.212/2014, Anexo X, art. 1º, redação do Decreto 271/2019 | regime de substituição tributária para operações/prestações subsequentes com bens/mercadorias do Anexo X | redação indicada com efeitos a partir de 01/01/2020; vínculo concreto depende do bem/operação/período | https://www.sefaz.mt.gov.br/legislacao/SubIndice.aspx?ID=212 |
| GO-NFE-R6 | Secretaria da Economia-GO; página NF-e atualizada em 23/04/2026; RCTE-GO arts. 167-A e 114, XXIV/XXV referenciados | NF-e modelo 55 pode ser utilizada em substituição à Nota Fiscal de Produtor modelo 4 | evidência estadual de substituição; não universalizar para outras UFs/períodos | https://goias.gov.br/economia/nf-e-nota-fiscal-eletronica/ |
| SPED-EFD-324-R6 | Receita Federal/SPED; Guia Prático EFD ICMS/IPI versão 3.2.4; Ato COTEPE/ICMS 86 de 09/09/2026 | edição específica do Guia Prático | publicada em 10/09/2026; consulta em 29/09/2026 | https://www.gov.br/sped/pt-br/assuntos/comunicados/efd-icms-ipi/nova-versao-do-guia-pratico-da-efd-icms-ipi-2 |
| NF3E-MOC-R6 | ENCAT/CONFAZ; MOC NF3-e, Anexo I – Leiaute, versão 1.00 | p. 6, campo `mod`: código 66 identifica a NF3-e; documento específico de energia elétrica | versão/publicação 04/2019; consulta em 29/09/2026 | https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc_nf3e_anexo-i_leiaute_v1-00.pdf |

### 24.4 Auditoria das 66 âncoras genéricas da R4

| Código | Marcador na R4 | Resultado R6 |
|---|---|---|
| `theme.tax_deferral` | lei específica | âncora específica R5: `RICMS-MT-ANEXO-VII-R5/TriBusca·H` |
| `theme.tax_substitution` | lei específica | âncora específica R6: `CTN-R5/RICMS-MT-ST-R6/TriBusca·H` |
| `theme.anticipation` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.input_credit` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.presumed_credit` | lei específica | âncora específica R5: `RICMS-MT-ANEXO-VI-R5/TriBusca·H` |
| `theme.credit_reversal` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.credit_maintenance` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.credit_appropriation` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.reimbursement` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.tax_benefit` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.tax_base_reduction` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.rate_reduction` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.tax_rate` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.additional_rate` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.withholding` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.non_cumulativity` | lei específica | âncora específica R5: `L10637/L10833/LC214-R5·H` |
| `theme.tax_dispute` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `theme.tax_consultation` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `treatment.tax_deferral` | lei específica | âncora específica R5: `RICMS-MT-ANEXO-VII-R5/TriBusca·H` |
| `treatment.tax_substitution` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `treatment.monophase` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `treatment.tax_suspension` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `treatment.presumed_credit` | lei específica | âncora específica R5: `RICMS-MT-ANEXO-VI-R5/TriBusca·H` |
| `treatment.tax_base_reduction` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `treatment.rate_reduction` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `treatment.zero_rate` | lei específica | âncora específica R5: `LC214-R5/TriBusca·H` |
| `treatment.anticipation` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `treatment.credit_reversal` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `treatment.credit_maintenance` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `regime.regular` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `regime.special` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `regime.free_trade_areas` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `operation.importation` | lei específica | âncora específica R5: `L10865/SISCOMEX-R5·H` |
| `operation.exportation` | lei específica | âncora específica R5: `SISCOMEX-R5·H` |
| `operation.transport_service` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `operation.financial_lease` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `subject.tax_substitute` | lei específica | âncora específica R6: `CTN-R5/RICMS-MT-ST-R6·H` |
| `subject.substituted` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `subject.rural_producer` | lei específica | âncora específica R5: `L8212/RICMS-MT-ANEXO-VII-R5·H` |
| `subject.importer` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `subject.exporter` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `subject.final_consumer` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `subject.non_taxpayer` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `subject.buyer` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `subject.supplier` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `subject.withholding_agent` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `subject.intermediary` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `subject.non_resident` | lei específica | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.institutes` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.amends` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.regulates` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.revokes` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.suspends` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.reinstates` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.extends` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.postpones` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.corrects` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.consolidates` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.disciplines` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.clarifies` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `event.repeals_partially` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `act_type.law` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `act_type.complementary_law` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `act_type.decree` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `act_type.ordinance` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |
| `act_type.resolution` | ato oficial | `NEEDS_EVIDENCE` — marcador genérico removido; nenhuma fonte foi inventada |

**Regra R6:** `NEEDS_EVIDENCE` não é falha escondida; é bloqueio explícito de promoção daquela definição como juridicamente verificada. A TAX-03 pode aprovar, retipar ou remover depois de conferir fonte específica.

### 24.5 G01 — inventário tributário e estado temporal

A R5 mantém o inventário ampliado da R4, mas substitui a pretensão de completude por uma matriz temporal mínima. Cada `tax.*` deve poder registrar, sem alterar a identidade do conceito: `constitutional_status` (quando aplicável), `institution_status` = previsto/instituído, `temporal_status` = vigente/extinto/transição e `applicability` = condicionado ao dispositivo/ente/período. Esses valores são fatos da norma/edição, não novos tributos.

Fontes R5 foram rechecadas para CIDE-Combustíveis, CIDE-Remessas, AFRMM, CONDECINE, FUST, FUNTTEL, CPRB, contribuições previdenciárias e produtor rural. `tax.state_primary_products_contribution` permanece **NEEDS_EVIDENCE por UF**: o fundamento constitucional não prova que um Estado específico a instituiu nem que um cliente está sujeito. Tributos históricos continuam temporalmente qualificados; a R5 não converte CPMF em tributo corrente.

### 24.6 Reforma tributária — G02/G17/G18

- `tax.ibs`, `tax.cbs` e `tax.is` são conceitos de tributo.
- `theme.split_payment` é mecanismo de extinção/recolhimento ligado ao IBS/CBS, com base nos arts. 27 e 31–35 da LC 214 compilada; **não é tributo**.
- `theme.personalized_refund` representa a devolução personalizada/cashback dos arts. 112–124; **não é tributo** e exige o contexto IBS/CBS para desambiguar “cashback”.
- Cesta Básica Nacional, redução de alíquota, alíquota zero, regimes diferenciados e regimes específicos são tratamento/regime/tema conforme o enunciado concreto; não são convertidos em benefício automaticamente.
- Créditos de IBS/CBS permanecem separados de crédito tributário do CTN, crédito presumido e crédito financeiro.
- Toda classificação dependente de LC 214 deve guardar artigo, edição e data de efeitos. A redação compilada consultada inclui alterações da LC 227/2026.

### 24.7 G03 — crédito e abstenção

A palavra isolada **“crédito”** permanece `AMBIGUOUS`. Positivos do corpus:
- “crédito presumido de 62,14% do ICMS” → `theme.presumed_credit` / `treatment.presumed_credit`;
- “créditos de IBS/CBS apropriados” → contexto de crédito de entrada/não cumulatividade, conforme dispositivo;
- “crédito tributário” em CTN → `theme.assessed_tax_credit`.
Contraexemplo: “crédito disponível” sem tributo, origem ou mecanismo → **abstenção**; não mapear para `theme.presumed_credit`.

### 24.8 G05/G11/G12/G20/G21 — fronteiras e relações

| Par/fronteira | Decisão R5 | Positivo / contraexemplo |
|---|---|---|
| `operation.transport_service` × transporte específico | **hierarquia funcional somente quando houver prestação contratada**; carga/passageiros/valores podem ser `narrower_than`; modal fica atributo. | “prestação de transporte de carga” → específico; deslocamento próprio → não é serviço. |
| `operation.loan_of_fungibles` × `operation.loan_granting` | **manter separados + `related_to`**; mútuo civil pode recair sobre fungíveis, concessão de empréstimo descreve a operação financeira. | mútuo de mercadoria fungível ≠ crédito bancário; mútuo em dinheiro pode exigir ambos se o texto provar ambos. |
| `operation.customs_transit` × `regime.customs_transit` | **manter em dimensões distintas + `related_to` condicionado.** | movimento sob regime ≠ mera menção ao regime sem operação. |
| venda à ordem × triangulação | `operation.sale_on_order` continua conceito específico; triangulação permanece estrutura de partes/fluxo, não alias nem código automático. | “venda à ordem” expressa → conceito; três partes sem regime de venda à ordem → não mapear. |
| `impact_operational.tax_master_data` × `impact_system.tax_master_data` | manter distintos. | obrigação de revisar cadastro pode ser operacional sem provar SAP/J1BTAX/DRC. |
| `subject.tax_substitute` → `subject.tax_responsible` | manter `narrower_than` **somente como inclusão semântica jurídica**, sem propagação classificatória; CTN arts. 121/128 + lei do tributo precisam sustentar o caso. | substituto legal comprovado → responsável; “fabricante” isolado → não prova substituição. |

**Eventos e arestas.** `amends`, `revokes`, `repeals_partially`, `regulates`, `suspends`, `reinstates`, `postpones` e `corrects` podem ser evento e também gerar aresta dirigida **somente quando o ato-alvo/dispositivo estiver identificado**. `institutes` é evento de criação e pode apontar para o conceito instituído, mas não cria por si uma aresta entre dois atos. `clarifies` pode gerar relação interpretativa quando o ato-alvo estiver expresso; sem alvo, fica evento/fato. `cites` nunca implica `amends`.

### 24.9 G08/G09/G10/G13 — setor, produto e impacto

**Frigorífico/carnes.** CNAE/CONCLA distingue, entre outros, frigorífico com abate (ex.: 1012-1/03 para suínos), matadouro sob contrato (1012-1/04) e fabricação de produtos de carne sem abate integrado (1013-9/01). Portanto `sector.meatpacking`, `sector.slaughterhouse`, `sector.meat_products`, `sector.cold_storage` e `sector.meat_distribution` permanecem conceitos distintos com `overlap` contextual; **não são aliases exatos**.

O RICMS/MT, Anexo VI art. 6º, fornece caso tributário real: crédito presumido em saídas interestaduais de carnes/subprodutos, condicionado a estabelecimento com atividade de abatedouro ou frigorífico em CNAEs expressos. O ato permite anotar separadamente tributo (`tax.icms`), tratamento (`treatment.presumed_credit`), operação (`operation.sale` + `operation_scope.interstate` quando o fato assim indicar), produto (carne/subproduto), setor/CNAE e condições. Nenhuma dessas dimensões prova automaticamente as demais.

**Produtos.** `product.soy` permanece amplo. “Soja” isolada não determina grão/semente/óleo/farelo e nunca determina NCM de oito dígitos. Serviços/intangíveis usam NBS quando houver vínculo oficial suficiente; não são forçados a NCM.

**Impactos.** `impact_operational.*` descreve possível mudança de processo; `impact_system.*` descreve possível mudança de categoria sistêmica. “Precisa alterar SAP/J1BTAX/DRC” depende do ambiente privado do cliente. “DRC” isolado continua `AMBIGUOUS`.

### 24.10 Corpus oficial congelado R5

O corpus registra referências suficientes para reprodução sem copiar longos trechos. “Não atribuir” é parte do teste.

| ID | Fonte/ato, data/edição | Jurisdição / dispositivo | Dimensão esperada e positivos | NÃO atribuir / ambiguidade / nota temporal |
|---|---|---|---|---|
| C01 | LC 214/2025 compilada c/ LC 227/2026 | Federal; arts. 27, 31–35 | `tax.ibs`, `tax.cbs`, `theme.split_payment` | split payment ≠ tributo; efeitos/implementação por dispositivo |
| C02 | LC 214/2025 compilada | Federal; arts. 112–124 | `theme.personalized_refund`; IBS/CBS | “cashback” comercial ≠ conceito; consumo-base CBS 2027/IBS 2029 |
| C03 | EC 132/2023 + LC 214 | Federal; Cesta Básica | regime/tratamento conforme regra; IBS/CBS | cesta ≠ tributo; produto sem NCM explícito não recebe NCM |
| C04 | Lei 10.865/2004 | Federal; art. 1º | `tax.pis_pasep_import` e `tax.cofins_import` separados; importação | menção a uma contribuição não prova a outra |
| C05 | LC 123/2006 + Portal Simples | Federal; art. 18-A/Simei | `subject.mei`, `regime.simei` | ser MEI ≠ prova automática de opção válida no período |
| C06 | Receita Federal PER/DCOMP + IN RFB 2.055/2021 | Federal; orientação atualizada em 2026 e IN referenciada pela RFB | temas de restituição/ressarcimento/compensação; candidato de procedimento | **não** restaurar `obligation.per_dcomp`; meio/procedimento varia pelo crédito |
| C07 | Receita Federal DCTFWeb/MIT; serviço atual + esclarecimento oficial | Federal; serviço integrado / escrituração geradora; fonte `RFB-MIT-R6` | `obligation.dctfweb` + MIT como `UNMAPPED_DIMENSION` candidato a `bookkeeping` | MIT ≠ obrigação autônoma ≠ plataforma; nenhuma nova dimensão é criada sem governança |
| C08 | MOC NF-e 7.0 | Nacional DF-e; item NFA-e/séries/procEmi | `document.nfe` + propriedade de emissão NFA-e | sem `document.nfae`; modelo continua 55 |
| C09 | MOC NF-e 7.0 + SEFAZ-GO | Nacional/GO; substituição modelo 04 | `document.rural_producer_invoice` somente modelo 04; `document.nfe` para 55 | NFP-e/NF-e 55 ≠ modelo 04; UF/período obrigatórios |
| C10 | RICMS/MT, Dec. 2.212/2014, Anexo VI art. 6º | MT; saídas interestaduais de carnes | ICMS + crédito presumido + frigorífico/abatedouro + carne + CNAEs | CNAE ≠ alias de segmento; benefício não se infere só do setor |
| C11 | RICMS/MT, Anexo VII art. 7º + regras gerais | MT; soja de produção mato-grossense | ICMS + diferimento + soja + produtor rural quando expresso | “soja” ≠ NCM; diferimento condicionado e temporal |
| C12 | LC 116/2003 + LC 344/2021 Goiânia e alterações | Município de Goiânia; serviços de informática | ISS + software/serviço + jurisdição municipal | regra nacional não substitui lei municipal; software ≠ NBS/NCM automático |
| C13 | Guia Prático EFD ICMS/IPI **versão 3.2.4**, publicado em 10/09/2026 sob Ato COTEPE/ICMS 86 de 09/09/2026 | Nacional; Receita Federal/SPED; alvo: edição 3.2.4 | `obligation.efd_icms_ipi`, ICMS/IPI conforme registro aplicável | EFD ≠ documento NF-e; edição de guia não prova impacto de cliente; fonte: `SPED-EFD-324-R6` |
| C14 | Portal NF-e, NT 2025.002 v1.50 (03/06/2026) | Nacional DF-e; RTC | `document.nfe`, alteração de leiaute, IBS/CBS quando campos/regra expressos | nota técnica ≠ novo modelo fiscal |
| C15 | Lei 10.336/2001 | Federal | `tax.cide_fuels`, combustíveis | combustível ≠ contribuinte; CIDE ≠ ICMS |
| C16 | Lei 9.998/2000 | Federal; telecom | `tax.fust`, `sector.telecommunications` quando texto sustentar | setor não prova sujeição concreta |
| C17 | Lei 10.052/2000 | Federal; telecom/tecnologia | `tax.funttel` | FUST ≠ Funttel |
| C18 | MP 2.228-1/2001 | Federal; audiovisual | `tax.condecine`, mídia/audiovisual | não inferir ISS/ICMS |
| C19 | Lei 10.893/2004 | Federal; transporte aquaviário/comércio exterior | `tax.afrmm`, operação de importação/transporte quando expressa | AFRMM ≠ frete |
| C20 | Lei 12.546/2011 + Lei 14.973/2024 | Federal; transição | `tax.cprb`, folha/receita conforme período | “desoneração” isolada é SEARCH_RELATED |
| C21 | Lei 8.212/1991 | Federal; produtor rural/previdência | contribuição rural/sujeitos conforme dispositivo | produtor rural ≠ obrigação concreta sem hipótese |
| C22 | Lei 9.656/1998 + LC 214 | Federal; saúde/planos | setor de saúde/plano + regime específico quando dispositivo expresso | setor ≠ benefício |
| C23 | LC 214 | Federal; serviços financeiros | regime específico financeiro quando dispositivo expresso | operação financeira ≠ regime automaticamente |
| C24 | Lei 11.488/2007 | Federal; REIDI/infraestrutura | `regime.reidi`, construção/infraestrutura quando expressa | obra comum ≠ REIDI |
| C25 | Portal Único Siscomex | Federal; comércio exterior | DUIMP/DU-E e operações aduaneiras conforme documento | declaração ≠ NF-e; cronograma importa |
| C26 | CONFAZ, Ajuste SINIEF 07/2005 + MOC NF-e | Nacional/estadual | tipo de ato + NF-e modelo 55 | Ajuste ≠ evento “altera” sem comparar alvo |
| C27 | CONFAZ, Convênio ICMS 190/2017 + RICMS/MT | Nacional/MT | convênio, benefício reinstituído quando ato local comprovar | convênio nacional ≠ fruição privada |
| C28 | Prefeitura de Goiânia, Decreto 2.824/2025 | Goiânia; SGISS | ISS, NFS-e/declarações municipais conforme artigo | sistema municipal ≠ obrigação universal |
| C29 | IBGE/CONCLA CNAE | Nacional; 1012-1/03, 1012-1/04, 1013-9/01 | atividade oficial e overlap com setores de carne | CNAE ≠ segmento nem benefício |
| C30 | MOC NF-e 7.0 Anexo I | Nacional; regra de NCM no item | NCM quando explícito no documento | palavra “soja” isolada não gera oito dígitos |
| C31 | MOC NF3-e, Anexo I – Leiaute, **versão 1.00**, publicação 04/2019 | Nacional; ENCAT/CONFAZ; p. 6, campo `mod` = 66; alvo: NF3-e | `document.nf3e` e documento fiscal de energia elétrica | não inferir benefício, alíquota, cliente ou impacto sistêmico; fonte: `NF3E-MOC-R6` |

**Cobertura do corpus (31 casos):** federal, estadual e municipal; histórico (SINIEF/modelo 04), pré-reforma, transição 2025–2029 e atual/futuro; ICMS, ISS, IPI/EFD, PIS/Cofins, IBS/CBS e exações fora do núcleo; agro, carnes, combustíveis, **energia elétrica/NF3-e (C31)**, telecom, saúde, software, indústria, comércio, transporte, financeiro, construção e comércio exterior. Inclui lei, LC, decreto, convênio, Ajuste SINIEF, orientação/instrução administrativa, nota técnica, manual técnico e obrigação acessória. O corpus é **amostra**, não denominador de completude.

#### Reexecução dos oito casos obrigatórios

| Caso | Resultado R6 |
|---|---|
| 1. Convênio ICMS + crédito presumido + interestadual | **PASS com ato real:** C10/C27. Classificar ICMS, tratamento de crédito presumido, operação interestadual, produto/sector/CNAE somente quando explícitos. |
| 2. ISS municipal + software | **PASS:** C12. LC 116 dá moldura nacional; Goiânia exige ato local. Software/serviço não recebe NCM. |
| 3. Benefício + frigorífico | **PASS:** C10/C29. RICMS/MT art. 6º explicita crédito presumido e CNAEs; setor, atividade, produto e tratamento ficam separados. |
| 4. Alteração de leiaute NF-e | **PASS:** C14. Nota técnica altera leiaute/regras; não cria novo documento nem prova mudança SAP do cliente. |
| 5. EFD ICMS/IPI | **PASS:** C13. Obrigação/escrituração separada de NF-e e de tributo individual. |
| 6. Diferimento + venda de soja + produtor rural | **PASS:** C11. Diferimento/soja/produtor rural e condições podem coexistir; “soja” não gera NCM. |
| 7. “Crédito” ambíguo | **PASS por abstenção:** C01/C10 + §24.7. “crédito” isolado = `AMBIGUOUS`. |
| 8. “Soja” sem NCM | **PASS por abstenção:** C11/C30. `product.soy` possível se lexicalmente suficiente; NCM de 8 dígitos = não atribuir. |

#### Revalidação dos quatro casos R4

| Caso | Resultado R6 |
|---|---|
| PIS/Pasep-Importação × Cofins-Importação | **PASS:** manter códigos separados; Lei 10.865/2004, art. 1º. |
| MEI × Simei | **PASS:** `subject.mei` ≠ `regime.simei`; não propagar opção. |
| PER/DCOMP | **PASS:** continua fora de `obligation.*`; futura dimensão `procedure` só com ganho semântico demonstrado. |
| Órgão × ente público | **PASS:** órgão administrativo ≠ pessoa jurídica/ente; não inferir imunidade. |

### 24.11 Matriz G01–G25

| Gap | Estado R4 | Trabalho R5 | Evidência | Resultado |
|---|---|---|---|---|
| G01 | aberto | fontes estruturais e exações setoriais rechecadas; estado temporal explicitado | manifesto §24.3 | PARTIAL |
| G02 | aberto | LC 214 compilada + LC 227; efeitos por dispositivo | C01–C03 | PARTIAL |
| G03 | aberto | corpus real e regra de abstenção de “crédito” | §24.7, C01/C10 | PARTIAL |
| G04 | aberto | regimes mantidos condicionais; sem promoção por similaridade | manifesto/corpus | OPEN |
| G05 | aberto | quatro sobreposições documentadas e facetas preservadas | §24.8 | PARTIAL |
| G06 | aberto | NFA-e decidida; modelo 04 qualificado; demais DF-e ainda por edição | C08/C09 | PARTIAL |
| G07 | aberto | MIT retipado; DeRE/GIA e obrigações locais continuam temporais | §24.2 | PARTIAL |
| G08 | aberto | CNAE/CONCLA + caso tributário real de frigorífico/abatedouro | C10/C29 | PARTIAL |
| G09 | aberto | setor/papel/canal continuam separados; corpus multissetorial | C12/C16/C22–C24 | PARTIAL |
| G10 | aberto | universo aberto; soja/NCM e NBS reforçados | C11/C30 | PARTIAL |
| G11 | aberto | hierarquia substituto→responsável reavaliada com trava de não propagação | §24.8 | PARTIAL |
| G12 | aberto | regra evento×aresta definida; corpus ainda não cobre todos os verbos | §24.8 | PARTIAL |
| G13 | aberto | fronteira impacto operacional×sistêmico e DRC ambíguo | §24.9 | PARTIAL |
| G14 | aberto | manifesto de fontes/edições criado; 66 marcadores auditados | §24.3–24.4 | PARTIAL |
| G15 | aberto | corpus estratificado criado; sem métrica falsa de completude | §24.10 | PARTIAL |
| G16 | aberto | C13 congelado na versão 3.2.4 e C31 adiciona energia específica; porém os 31 casos ainda não registram uniformemente trecho, edição, data, órgão, jurisdição e alvo | §24.10 | PARTIAL |
| G17 | parcial | tributos/regimes transversais rechecados; entidades Sistema S ainda não individualizadas | §24.3/24.5 | PARTIAL |
| G18 | parcial | split/cashback/cesta/transição tipados sem virar tributo | C01–C03 | PARTIAL |
| G19 | parcial | MIT/NFA-e/modelo 04/PER-DCOMP corrigidos | C06–C09 | PARTIAL |
| G20 | aberto | decisão de papel evento/aresta estabelecida | §24.8 | PARTIAL |
| G21 | aberto | sobreposições principais recebem decisão manter/hierarquia/related_to | §24.8 | PARTIAL |
| G22 | parcial | corpus multissetorial ampliado; universo segue aberto | §24.10 | PARTIAL |
| G23 | aberto | fronteiras permanecem sem propagação; amostra real ampliada | §24.8–24.10 | PARTIAL |
| G24 | aberto | NFA-e encerrada; PER/DCOMP mantido fora de obrigação; naturezas setoriais ainda pedem revisão fina | §24.2/24.3 | PARTIAL |
| G25 | parcial | 4 casos R4 reais + modelo 04 por UF/edição + alias ITCD resolvido | §24.2/24.10 | PARTIAL |

Nenhum gap desapareceu. Não há `ACCEPTED_RISK` nesta revisão.

### 24.12 Matriz final por dimensão

A contagem abaixo é calculada sobre as linhas canônicas desta R5; a decisão é **proposta para revisão**, não aprovação.

| Dimensão | Nº conceitos | Fonte dominante | Corpus testado | Decisão proposta |
|---|---:|---|---|---|
| tax/tax_species | 48 | CF/CTN/leis/LC214 | C01–C04, C15–C21 | REVISE |
| theme/treatment | 56 | leis + TriBusca | C01–C03, C10–C12 | REVISE |
| regime | 19 | LC214 e leis setoriais | C05, C22–C24 | REVISE |
| operation/facetas | 166 | leis/NBS/SISCOMEX + TriBusca | C04, C10–C11, C19/C25 | REVISE |
| document | 12 | ENCAT/CONFAZ/NFS-e | C08–C09, C14, C26/C30 | REVISE |
| obligation/platform | 24 | RFB/SPED/entes | C06–C07, C13/C28 | REVISE |
| sector/product | 233 | CNAE/NCM/NBS + TriBusca | C10–C12, C15–C16, C29–C30 | REVISE |
| subject | 26 | CTN/leis | C05, C10–C11/C21 | REVISE |
| event/act_type | 21 | atos oficiais + TriBusca | C14/C26/C27 | REVISE |
| impact_* | 19 | TriBusca + contexto privado | casos 4/5 | REVISE |
| sphere | 4 | IBGE/entes oficiais | corpus multijurisdicional C09–C12/C28 | REVISE |

Nenhuma dimensão recebe `READY` antes do novo recheck independente, porque ainda existem linhas `NEEDS_EVIDENCE`.

### 24.13 R5 → R6

**Contagem final R6:** **628 códigos canônicos únicos** (R5: 629). A única redução é a retirada de `platform.mit`, evitando tipagem ontológica não aprovada.

**Adicionados:** nenhum código canônico.  
**Removidos na R6:** `platform.mit`. A decisão R5 sobre `document.nfae` permanece preservada.  
**Retipados:** nenhum código canônico. MIT passa a `UNMAPPED_DIMENSION`, semanticamente descrito como componente de escrituração/serviço integrado à DCTFWeb; `bookkeeping.mit` é apenas candidato futuro condicionado à extensão formal da TAX-01.  
**Definições alteradas:** nenhuma das fronteiras materiais já aprovadas na R5; somente MIT e rastreabilidade B2.  
**Relações alteradas:** removida a relação canônica `platform.mit related_to obligation.dctfweb`; a relação MIT→DCTFWeb permanece evidência documental, sem código/propagação.  
**Aliases alterados:** nenhum na R6.  
**Fontes atualizadas:** `RFB-MIT-R6`, `RICMS-MT-ST-R6`, `GO-NFE-R6`, `SPED-EFD-324-R6`, `NF3E-MOC-R6`.  
**Corpus:** C01–C31; C13 congelado em 3.2.4; C31 cobre energia elétrica/NF3-e.  
**Gaps:** G16 = PARTIAL; G04 permanece OPEN; os demais permanecem PARTIAL.

### 24.14 UNMAPPED, NEEDS_EVIDENCE e conceitos corrigidos

**UNMAPPED controlados:** MIT (`UNMAPPED_DIMENSION`, candidato de futura dimensão `bookkeeping` sujeita à governança TAX-01), triangulação genérica (estrutura de partes, sem código próprio), procedimento PER/DCOMP (até decisão de dimensão), módulos/componentes adicionais não inventariados, produtos/serviços/segmentos fora do corpus e qualquer NCM/NBS/CNAE não explicitamente provado.

**NEEDS_EVIDENCE:** todas as linhas listadas no §24.4 que não receberam âncora específica R5. Elas não podem ser promovidas como definição juridicamente verificada apenas por similaridade lexical.

**Métrica de conceitos com evidência reforçada:** a R6 **remove a contagem “28”** da R5 por não possuir regra objetiva/lista fechada reproduzível. Evidência é avaliada por conceito e chave de fonte; esta revisão não declara uma quantidade agregada de conceitos juridicamente reforçados.

**Removidos/reclassificados:** herda R5: `document.nfae` → propriedade de `document.nfe` e `JURISDICTIONAL_LABEL` rejeitado; R6: `platform.mit` removido do catálogo e MIT fica `UNMAPPED_DIMENSION` até decisão sobre possível extensão `bookkeeping`.

### 24.15 Perguntas bloqueantes restantes

1. Quais linhas `NEEDS_EVIDENCE` recebem fonte específica suficiente para promoção após a TAX-03?
2. A TAX-01 deve ser formalmente estendida com uma dimensão `bookkeeping` (ou equivalente) para componentes/escriturações como MIT? Até essa decisão, MIT permanece fora do catálogo canônico.
3. Um corpus maior justifica dimensão `procedure` para PER/DCOMP, consulta e contencioso, ou propriedades/relações bastam?
4. Quais subtipos do Sistema S e taxas setoriais merecem códigos canônicos sem gerar catálogo combinatório?
5. Quais eventos de §24.8 merecem arestas próprias persistidas versus relação genérica qualificada?
6. Quais documentos estaduais/municipais e modelos legados entram no próximo inventário sem confundir cobertura de fonte com cobertura conceitual?

### 24.16 Gate de saída da R6

**`PRONTO PARA RECHECK INDEPENDENTE`**

Isso significa apenas que a R6 corrige B1–B4 e consequências diretas e está pronta para **recheck independente do SHA exato**. Não significa aprovação da R6, não libera `TAX-04` e não autoriza migration, banco, classificador, embeddings, IA, matching, backend, frontend, conector, deploy ou merge.

### 24.17 Validação automatizada R6

As verificações abaixo foram executadas programaticamente sobre o conteúdo do head candidato, sem alterar TAX-01, R3, R4, roteiro TAX-03 ou R5.

| Verificação | Regra executada | Resultado |
|---|---|---|
| Códigos canônicos | linhas de tabela entre §§4–13 com padrão `dimensao.codigo` | **628 linhas / 628 códigos únicos** |
| Duplicidade | cardinalidade do conjunto de códigos × total | **0 duplicidades** |
| `NEEDS_EVIDENCE` | contagem nas linhas canônicas | **55**, sem alteração versus R5 |
| Marcador genérico | `lei específica` ou `ato oficial` na âncora canônica | **0** |
| Evidência órfã ativa | átomos da coluna Âncora confrontados com chaves declaradas no manifesto | **0** |
| Chaves R6 novas | `RFB-MIT-R6`, `RICMS-MT-ST-R6`, `GO-NFE-R6`, `SPED-EFD-324-R6`, `NF3E-MOC-R6` | **5/5 definidas e usadas** |
| Chaves rejeitadas B2 | uso canônico de `RICMS-MT-R5` ou `UF-R5` | **0** |
| MIT | busca por `platform.mit`, `obligation.mit` e `bookkeeping.mit` canônicos | **0/0/0**; MIT = `UNMAPPED_DIMENSION` |
| Corpus | linhas Cnn | **31 casos (C01–C31)** |
| Gaps | linhas G01–G25 + estado final | **25/25: 24 PARTIAL + 1 OPEN + 0 RESOLVED** |
| Matriz dimensional | soma das contagens finais | **628** |
| Métrica B4 | busca da alegação ativa “28 conceitos críticos” | **removida** |
| Delta canônico R5→R6 | mapa `código → linha` contra SHA R5 `c66ed457...` | removido apenas `platform.mit`; alteradas somente as âncoras de `theme.tax_substitution`, `document.rural_producer_invoice` e `subject.tax_substitute` |

**Definições de evidência sem uso.** O detector também foi executado sobre o catálogo herdado de fontes. Existem chaves históricas R5 que não são citadas por seu identificador literal no corpo R6 porque o arquivo preserva a matriz ampla de fontes e alguns registros usam chaves legadas mais curtas. Isso não é referência órfã. Para o delta R6, o critério é estrito: **nenhuma das cinco novas definições R6 está sem uso** e **nenhuma referência R6 usada em linha canônica está sem definição**.

**Comandos lógicos reproduzíveis:** (1) extrair linhas canônicas por regex; (2) comparar cardinalidade total/única; (3) extrair a coluna Âncora e normalizar sufixos `·O/·T/·H`; (4) confrontar átomos de evidência com as chaves do manifesto; (5) comparar mapas de códigos entre R5 e R6; (6) contar C01–C31 e G01–G25; (7) somar a matriz final. O revisor independente deve repetir esses controles no SHA exato.

