# E9-MOTOR R1 — desenho do ciclo único do motor de Anatomia

- **Mandato** — COORD → EXEC F1, [Issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-7008351634).
- **Base técnica** — [#324 @ 17e4cbbf868ded9b40b1966d2802a480911808bc](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/324), motor `4b96f97783631b77404493139c2c786554222deda2489e66d3b9c29be981d06a`. Matriz candidata: 61 células, 25 cobertas, 36 pendentes de cobertura e 4 aceitas, com cinco amostras RFB aceitas. A main de referência `d53fb3e2` tem 13 cobertas, 48 pendentes de cobertura e as mesmas 4 aceitas. A F1 permanece em 50,2%.
- **Referências** — [E9-PLAN §3](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/blob/2618932432ecd76dd717cf69f0bab6ed0c0208e6/ops/anatomy/e9-acervo/plan/E9-PLAN.md), [medição E9-M1b por arquivo](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-7008100942), [prova Portaria 635](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/blob/17e4cbbf868ded9b40b1966d2802a480911808bc/ops/anatomy/e9-acervo/portaria635-equivalence.mts).
- **Entrega** — desenho para revisão. O PR de implementação será único, após decisão do COORD sobre este documento e sobre o #324. O SHA de comparação e os hashes do acervo ficam fixos no manifesto de prova. Qualquer incorporação posterior de correção do #324 exige identificar a nova base e repetir a prova antes da integração.

## 1. Frentes, alterações admitidas e regressões a impedir

As listas de arquivos indicam o desenho para a futura implementação. A regra compartilhada fica inalterada quando existir um caminho específico de fonte. Arquivos novos que mudem interpretação passam a entrar no manifesto de identidade.

### M-RFB — segmentos 999 e 1000

- **Regra.** Preservar o tipo original e a proveniência de cada segmento. Para 999, classificar somente quando o texto e a posição provarem a função: romano sem separador exige contexto de enumeração e pai compatível. Fórmula de preâmbulo exige cabeçalho e posição anterior aos dispositivos. `DECLARA:`/`RESOLVE:` só abre a estrutura do próprio ato quando a posição e o próximo dispositivo sustentarem a leitura. Para 1000, mapear assinatura com contexto final corroborado. Preservar casos ambíguos como lacuna. Evidências de tachado, remissão e citação prevalecem sobre as novas heurísticas. Seguir a árvore e o offset originais sem reescrever conteúdo.
- **Arquivos previstos.** `src/modules/anatomy/json-preparation.ts`, ramo RFB de `readers.ts`, `profile-rules.ts` se necessário e testes RFB de segmentos e perfil. `ops/anatomy/official-lot-rfb.ts` e cobertura passam pela prova de compatibilidade.
- **Alterações esperadas.** 141910 (IN médio, incisos e diagnóstico de tachado), 37103 (ADI pequeno, assinatura), 148629 (ADE pequeno, preâmbulo e anexo inline), 122645 (Resolução pequeno, preâmbulo), 148516 (texto do ADE médio). O 148516 fica parcial enquanto faltar o anexo próprio.
- **Proteções.** 108391, 115131, 133898, 142967 e 148693 precisam de prova individual. Em 115131, manter a evidência do segmento 104 vazio e tachado. Em 127905, 104314 e 116968, preservar as lacunas de anexos e o tratamento de citação e remissões. Em 148681, preservar corpo ausente, porte indeterminado e ausência de aceite. Qualquer delta textual ou estrutural incidental exige evidência e revisão específica antes de permanecer no PR.

### M-DOU — página HTML de ato do in.gov.br

- **Regra.** Preparar a página a partir de `article#materia .texto-dou` único, com identidade da publicação ancorada à epígrafe. Isolar elementos de navegação do portal. Dentro do ato, tratar ementa, dispositivos, anexos, tabelas e assinatura, respeitando a ordem e preservando offsets de origem. Conter anexos na hierarquia correta. Tratamento de scripts e imagens exige distinguir decoração de conteúdo material. Região ausente, concorrente, truncada ou ambígua produz leitura parcial, com evidência. Os limites originais de bytes, profundidade e nós seguem como padrão. Para M25, medir o orçamento do recorte e dos blocos do próprio ato. Se o recorte puro ainda exceder o limite, propor travessia incremental com orçamento por ato e por bloco, sem truncamento silencioso e com prova de limites sob carga. M28 é controle independente de ato grande.
- **Arquivos previstos.** `src/modules/anatomy/dou-preparation.ts` para a rota web ou módulo de preparação dedicado, `profile.ts`, `profile-rules.ts`, `engine.ts`, `readers.ts` e testes do perfil/roteamento. Compartilhar a medição de porte entre preparação e ferramenta, preservando os limiares E9. Comparar o texto com a região delimitada, sem usar a contagem da página bruta.
- **Alterações esperadas.** M23–M26, M28–M30 e M32–M34. M23 deve manter porte pequeno e M28 grande se a região e a contagem forem corroboradas. M25 precisa superar `html_complexity_limit` dentro do orçamento aprovado ou continuar parcial.
- **Proteções.** As rotas XML INLABS e PDF continuam com seus próprios contratos. `http:M9` e `http:M9-p58` ficam fora do leitor HTML de ato e conservam a lacuna de ordem de colunas. Manter idênticas as saídas não-DOU e os testes já aprovados do leitor DOU para outros layouts.

### M-CONFAZ — HTML Plone

- **Regra.** Delimitar `#content-core #parent-fieldname-text` único e corroborar a epígrafe no texto. Interpretar ementa e cabeçalhos espaçados com comparação normalizada, preservando o literal original. Associar `ANEXO ÚNICO` ao ato e conservar a ordem de notas, linhas e células das tabelas. Distinguir nota editorial inequívoca e redação anterior sem inferir vigência. `http:M3` recebe o mesmo desenho de orçamento limitado do DOU, calibrado separadamente. Imagem material, anexo ausente, tabela ambígua ou perda de texto mantêm a leitura parcial.
- **Arquivos previstos.** Preparador Plone dedicado, `profile.ts`, `profile-rules.ts`, `engine.ts`, `readers.ts`, testes de HTML Plone, anexos e porte. Roteamento vinculado à região comprovada para evitar aplicar a regra a HTML genérico.
- **Alterações esperadas.** M14, M16, M18–M21, M5 manual e `http:M3`/M4/M5. Usar M4 para provar anexo material, M3 para orçamento e M5 nas duas representações para equivalência de conteúdo sem confundir proveniência.
- **Proteções.** HTML sem o contêiner Plone segue no caminho atual. RFB, DOU, Sefaz-SP e perfis novos permanecem fora desta alteração. Os atos reservados do corpus não entram como insumo nem como evidência de cobertura.

### M-SEFAZ — artigos do RICMS/SP

- **Regra.** Preservar a preparação tipada e verificar a região já identificada. Reconhecer cabeçalhos hierárquicos e subtítulo de anexo como contexto, mantendo o texto e a árvore do artigo. Tratar bloco marcado `revogado` somente com estrutura e evidência explícitas da página, excluindo-o da seleção operativa e mantendo `legalStatus: unknown`. Qualquer ambiguidade preserva a limitação. A questão de proveniência `sefaz_sp_portal_local_preparation_only` depende de decisão registrada do COORD com base em evidência independente da qualidade da leitura.
- **Arquivos previstos.** `sefaz-sp-preparation.ts`, ramo Sefaz-SP de `readers.ts`, `profile-rules.ts` se necessário, testes `anatomy.sefaz-sp-portal` e casos L17/L21.
- **Alterações esperadas.** `ricms-art007`, 008 e 009 e `ricms-an1art041`, `ricms-an2art003` e 039. Conferir os blocos revogados em 041/039 e a ordem de artigos, títulos e anexos.
- **Proteções.** DOE-SP JSON mantém seu caminho. HTML sem prova tipada não ganha o tratamento especial. Saídas RFB, DOU e CONFAZ ficam equivalentes.

### M-PLANALTO — perfil próprio

- **Regra.** Definir preparação tipada para o HTML compilado, ligada ao SHA dos bytes, URL preservada e identidade da representação. Reusar BOM/charset/fallback aprovado por hash. Manter nota editorial, redação anterior, remissão e texto candidato com contextos distintos e conservadores. Comprovar que a região inclui o corpo e anexos materiais presentes. A compilação e menções de revogação não certificam vigência. Se a demarcação for ambígua ou a captura perder texto, manter a lacuna aberta.
- **Arquivos previstos.** Novo `planalto-preparation.ts`, `profile.ts`, `profile-rules.ts`, `engine.ts`, `readers.ts`, `ops/anatomy/official-coverage-matrix.ts` e testes de perfil, hash, título, recorte e corpus offline. `charset-policy.ts` continua fonte da decisão de decodificação.
- **Alterações esperadas.** `http:M1`, `http:M2`, M10 e M12. M10/M12 só entram em uma célula após prova do leiaute efetivo e medição do corpo. Comparar M1/M2 com passagens e representações independentes já preservadas, guardando a proveniência de cada uma.
- **Proteções.** Charset desconhecido ou hash divergente continua recusado. As quatro representações de normas.leg.br mantêm sua fonte e não recebem perfil Planalto. Perfis existentes mantêm a saída integral.

### M-LEG — perfil NORMAS-LEG

- **Regra.** Portar o delta focal da [L-LEG-01 #305](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/305) e usar a [prova de composição do #309](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/309) como referência comparativa. Usar plano de regiões exatas emitido internamente, ligado a bytes, HTML, URN, versão e representação. Metadados fornecidos pelo HTML não bastam. Distinguir nota de compilação, placeholder revogado e ambiguidades sem remover posição, alterar texto ou promover nota. Preservar identidade e comparabilidade por versão original/atualizada. A composição DOE-SP do #309 fica fora desta implementação.
- **Arquivos previstos.** `normas-leg-preparation.ts`, `profile.ts`, `profile-rules.ts`, `engine.ts`, `readers.ts`, `docs/anatomy/L-LEG-01-DESIGN.md`, testes do planejador e a projeção da fonte na ferramenta.
- **Alterações esperadas.** As quatro capturas das Leis 10.637/2002 e 10.833/2003 em original e atualizada recebem avaliação explícita. As duas atualizadas são o caminho prioritário para a célula grande. As originais só cobrem célula se houver plano válido, porte medido e completude.
- **Proteções.** Os registros históricos NORMAS-LEG seguem no ledger. Cada possível novo aceite exige prova frente aos resultados históricos fixados e decisão separada do COORD. Todas as demais fontes permanecem equivalentes fora do alvo.

## 2. Prova de equivalência e revalidação append-only

1. **Congelar a entrada.** Fixar SHA Git da base e do candidato, identidade do motor, arquivo, tamanho e SHA-256 por amostra, rota e perfil, identificação, versão, parâmetros e data de referência da leitura. Cobrir todas as amostras da matriz do #324. Usar apenas acervo oficial preservado e contracasos sintéticos fora da partição reservada. Registrar, antes de implementar, a lista de amostras e campos autorizados a mudar por fonte. Delta inesperado bloqueia a conclusão.
2. **Executar em dois checkouts isolados.** Generalizar a prova Portaria 635. Para cada amostra, gerar em ambos os lados SHA dos bytes, saída de preparação, texto canônico, partes e hierarquia, spans, mapas de origem, cobertura, limitações, status, entidades, evidências, elegibilidade, campos da identidade, hashes, entrada no lote ou baseline, porte e célula. Manter o hash integral da saída. Para comparação estrutural, neutralizar somente o `engineHash`, recalcular `analysisId` e `outputHash` pelo contrato e exigir igualdade dos demais campos da identidade. Valores e posições canônicas iguais com origem divergente falham. Para diagnóstico sem perfil real, comparar diagnóstico com diagnóstico e registrar a transição de perfil separadamente.
3. **Classificar.** Fora do alvo: exigir igualdade campo a campo e do hash neutralizado, inclusive prova da preparação e posições. Dentro do alvo: aprovar somente o conjunto declarado de diferenças, por amostra e por parte, com cobertura de caracteres, preservação de ordem, referência de origem e completude material. Fazer dois runs independentes e verificar SHA-256 do relatório determinístico. Se o `outputHash` integra o digest do lote/baseline, a identidade nova pode alterar `entrySha256` mesmo com leitura equivalente. Registrar ambos os digests e a diferença exata.
4. **Revalidar os cinco aceites correntes.** Provar caso a caso e calcular `lotEntrySha256` com as ferramentas do candidato. Requerer célula, leitura completa, zero caracteres não identificados, ausência de lacuna material e preservação de contexto e `legalStatus`. Toda mudança além dos campos derivados da identidade exige reavaliação independente de mérito, mesmo se a célula continuar a mesma. Mudança de porte ou célula exige decisão sobre a nova célula. Uma eventual perda precisa ficar explícita para o COORD.

| Amostra RFB | Célula atestada na base | Controle específico |
|---|---|---|
| 108391 | IN pequeno | Confirmar que o segmento 999 já tratado preserva estrutura e literal. |
| 115131 | IN grande | Preservar a evidência do segmento tachado vazio 104, árvore e posição dos anexos. |
| 133898 | IN pequeno | Conferir os segmentos 999 e a estabilidade da célula compartilhada. |
| 142967 | Portaria pequeno | Conferir preâmbulo, epígrafe e classificação dos segmentos 999. |
| 148693 | Portaria médio | Executar o controle Portaria 635 com prova da região operativa, anexos e contexto. |

5. **Simular e decidir.** Gerar propostas fora do arquivo oficial. Comparar a projeção antes, após a troca de identidade e em simulação temporária de append. Confirmar que registros antigos sob `4b96f977` deixam de conceder aceite no motor novo. Preservar os 18 registros históricos, incluindo os precedentes NORMAS-LEG. A revisão independente verifica os relatórios e a matriz por SHA. Somente mandato posterior autoriza append de registros, fixando amostra, célula, digest atual, motor novo, referência da revisão, limites e decisão do COORD. Um registro velho continua evidência da versão que aprovou.

## 3. Estimativa de células aptas à revisão

As faixas são tetos com o acervo disponível, condicionados a leitura completa pelo perfil próprio, porte comprovado, baseline e revisão. Cobertura de layout sozinha não conta como aceite. As cinco amostras atuais ocupam quatro células. A estimativa abaixo conta somente células adicionais.

| Frente | Faixa adicional | Células e dependências |
|---|---:|---|
| RFB | 0–4 | IN médio, ADI pequeno, ADE pequeno, Resolução pequeno. ADE médio fica dependente do anexo externo. |
| DOU HTML | 0–9 | IN pequeno/médio/grande, Decreto pequeno/grande, Portaria pequeno/médio e Resolução pequeno/grande. M25 é a única prova atual da IN grande. |
| CONFAZ | 0–5 | Convênio pequeno/grande, Ajuste SINIEF pequeno/grande e Protocolo pequeno. Para Convênio grande, basta uma leitura completa de M3 ou M4. |
| Sefaz-SP | 0–2 | Artigo pequeno/médio, com decisão de proveniência e evidência. |
| Planalto | 0–3 | Lei pequeno/médio/grande como teto da grade. Grande é a expectativa para M1/M2. M10/M12 podem coincidir com a mesma faixa ou não demonstrar o leiaute exigido. |
| NORMAS-LEG | 0–1 | Lei grande, sustentada pelas atualizadas. Original e atualizada são rotas distintas de prova. |
| **Total** | **0–24** | Teto de **28/61** se as quatro células atuais forem revalidadas e todas as hipóteses favoráveis se confirmarem. Sem decisão de proveniência Sefaz-SP, teto de **26/61**. |

O E9-PLAN estimava 15/61 antes da consolidação dos insumos DOU/CONFAZ e incluía a página PDF do DOU no ciclo. A estimativa desta seção usa o acervo do #324 e exclui a frente DOU PDF. A diferença não altera a contagem oficial nem supre coleções ausentes.

## 4. Ordem e gates de implementação

| Ordem | Etapa no mesmo PR draft | Evidência exigida ao fim |
|---|---|---|
| 0 | Congelar referência e construir o comparador offline. | Saída idêntica em dois checkouts do mesmo SHA. Manifesto e lista de deltas previamente revisáveis. |
| 1 | M-RFB. | Contraprovas de 999/1000, falso romano, citação, tachado, assinatura falsa e anexo material faltante. Primeira prova dos cinco aceites. |
| 2 | M-DOU e depois M-CONFAZ, com commits separados. | Testes de seletor ausente/duplicado, título errado, origem dos offsets, anexos, imagens e tabelas, casos M25/M28/M3/M4 e limites de CPU/memória. |
| 3 | M-SEFAZ. | Pequeno/médio, subtítulo, revogado e HTML sem preparação válida. Decisão de proveniência registrada ou limitação mantida. |
| 4 | M-PLANALTO e depois M-LEG, com commits separados. | Mudança de perfil demonstrada, charset fixado, prova por URN/versão, notas e preservação de identidade de fonte. |
| 5 | Compor e fechar uma identidade candidata. | Atualizar a lista de entradas da identidade para incluir os módulos novos, gerar pelo script e rodar `build-identity --check`, `tsc --noEmit`, `test:anatomy` e matriz de regressão offline. Regenerar lote, baseline e matriz só pelo fluxo autorizado no futuro. Rodar ANAT-04, comparar todas as fontes e confirmar CI exigido após Ready autorizado. |

Cada commit traz testes focados e o checkpoint offline do antes/depois. A revisão final examina a composição integral. Alteração em leitor comum, limiar de complexidade ou reconhecimento de anexo exige reteste cruzado das frentes. Uma identidade candidata sem equivalência ou reavaliação explícita fica no draft.

## 5. Riscos e limites

- **Omissão sem evidência.** Recorte pode esconder ementa, assinatura ou anexo. Provar limites da região, origem das partes e ausência de texto material excluído. Contracasos: rodapé parecido com assinatura, menus duplicados, anexos fora da região e título ambíguo.
- **Complexidade e profundidade.** Fixar orçamento mensurável por fonte, incluir bytes, nós, profundidade, tempo e pico de memória no resultado. Continuar parcial se o teto for excedido. Usar casos patológicos sintéticos e entradas reais grandes para aferição.
- **Falso positivo jurídico.** Preâmbulo, nota, histórico e citação conservam seus contextos. Reconhecimento estrutural não certifica vigência nem justifica seleção operativa ou promoção.
- **Exclusões do R1.** Página PDF do DOU, ordem de colunas do M9, DOE-SP P2-d, PDF de SC e Anexo Único externo de 148516 têm rotas próprias. OCR, criação de insumos ausentes, coleta, grants, decisões N/A de grade e mudanças em cadastro ou produção ficam fora. O corpus reservado permanece isolado. Este PR contém somente este documento.
