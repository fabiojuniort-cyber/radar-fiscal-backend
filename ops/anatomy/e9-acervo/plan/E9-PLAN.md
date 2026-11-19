# E9-PLAN — inventário das 48 células pendentes e plano de fechamento da E9

**Mandato:** COORD → EXEC F1 "E9-PLAN" (tribusca-control#116). Somente leitura e planejamento.
**Base:** main `d53fb3e2`, motor `4b96f977…`.
**Inventário legível por máquina:** `e9-plan-inventory.json`, no mesmo diretório.

**Estado oficial (matriz em `d53fb3e2`):**

| Situação | Células |
|---|---|
| Total da grade | 61 |
| Aceitas | 4 |
| Cobertas e não aceitas | 9 (4 do E9-A2 e 5 do E9-A3) |
| Pendentes de cobertura | 48 |

O critério da E9 é a matriz completa, sem fração: 61 de 61 aceitas.

## 1. Classes de obstáculo

| Classe | Significado |
|---|---|
| a | A amostra existe no acervo; falta ler ou validar. |
| b | Falta coleta, mas a fonte está acessível. |
| c | A fonte está bloqueada: grants P2-c suspensos, insumo manual (Planalto, CONFAZ, DOU) ou DOE-SP. |
| d | Falta perfil ou leitor no motor. |
| e | Célula possivelmente inexistente na fonte. |

**Regra para a classe (e):** a grade só aceita N/A com justificativa e decisão registrada. A base está em três lugares:
- `GRID_APPROVAL`, tribusca-control#116 c.6708512598 §2;
- `GridCell.applicability = { required: false, justification, evidence }`, em `ops/anatomy/official-coverage-matrix.ts`;
- `docs/anatomy/E9-COVERAGE-P1-P3.md`: "não encontrado no limite ≠ inexistente".

Por isso a classe (e) aparece sempre junto com outra classe, nunca sozinha.

## 2. As 48 células

| # | Célula | Classe | Obstáculo principal | Saída |
|---|---|---|---|---|
| 1 | RFB Portaria grande | c | P2-c suspenso (28 de 25 requisições usadas); médio e grande não encontrados no limite | coleta RFB |
| 2 | RFB ADI médio | c | P2-c suspenso; sem candidato | coleta RFB |
| 3 | RFB ADI grande | c/e | P2-c suspenso; ADI com 50 mil caracteres ou mais é improvável | N/A justificado, ou coleta |
| 4 | RFB ADE grande | c/e | P2-c suspenso; só existe se tiver anexo inline extenso | coleta ou N/A |
| 5 | RFB SC pequeno | c+d | P2-c suspenso; o corpo da SC vem em anexo PDF (rfb:148681 tem `bodyAbsent`) | coleta e leitura do anexo PDF |
| 6 | RFB SC médio | c+d | idem | idem |
| 7 | RFB SC grande | c+d/e | idem; SC grande é rara | idem, ou N/A |
| 8 | RFB Resolução médio | c | P2-c suspenso | coleta RFB |
| 9 | RFB Resolução grande | c | P2-c suspenso (a Res. CGSN 140/2018 existe e é grande) | coleta RFB |
| 10 | Planalto Lei pequeno | c+d | a origem recusa este ambiente; sem perfil Planalto | insumo Fábio e perfil |
| 11 | Planalto Lei médio | c+d | idem | idem |
| 12 | Planalto Lei grande | d | **M1 e M2 já estão no acervo**; falta o perfil Planalto | perfil Planalto |
| 13 | normas.leg.br Lei pequeno | b+d | fonte acessível; sem perfil (L-LEG-01) | coleta e perfil |
| 14 | normas.leg.br Lei médio | b+d | idem | idem |
| 15 | normas.leg.br Lei grande | d | **4 amostras no acervo** (Leis 10.637 e 10.833, cada uma original e atualizada); o perfil NORMAS-LEG só existe nos ramos do #305 e do #309 | perfil NORMAS-LEG |
| 16 | CONFAZ Convênio pequeno | c | insumo manual | insumo Fábio |
| 17 | CONFAZ Convênio médio | a?/c | o corpus 02 (CV100/97, 30.591 caracteres) é HTML "sanitized" de fixture, não bytes oficiais com meta | decisão de proveniência; senão insumo |
| 18 | CONFAZ Ajuste SINIEF pequeno | c | insumo manual | insumo Fábio |
| 19 | CONFAZ Ajuste SINIEF médio | c | insumo manual | insumo Fábio |
| 20 | CONFAZ Protocolo pequeno | c | insumo manual | insumo Fábio |
| 21 | CONFAZ Protocolo médio | c | insumo manual | insumo Fábio |
| 22 | CONFAZ Protocolo grande | c/e | insumo manual; Protocolo grande é raro | insumo ou N/A |
| 23 | DOU IN pequeno | c | insumo manual HTML | insumo Fábio |
| 24 | DOU IN médio | c (a?) | o corpus 11 (IN RFB 2.342/2026, 17.021 caracteres) existe, mas como **XML INLABS**, e a grade exige HTML do in.gov.br | decisão de layout; senão insumo |
| 25 | DOU IN grande | c | insumo manual | insumo Fábio |
| 26–28 | DOU Decreto, 3 portes | c | insumo manual | insumo Fábio |
| 29 | DOU Portaria pequeno | c | insumo manual | insumo Fábio |
| 30 | DOU Portaria médio | c (a?) | o corpus 10 (Portaria SAES/MS 4.940/2026, 18.877 caracteres) é XML INLABS | decisão de layout; senão insumo |
| 31 | DOU Portaria grande | c | insumo manual | insumo Fábio |
| 32–34 | DOU Resolução, 3 portes | c | insumo manual | insumo Fábio |
| 35 | DOU Despacho pequeno | c (a?) | o corpus 07 (Despacho MF, 1.222 caracteres) é XML INLABS | decisão de layout; senão insumo |
| 36 | DOU Despacho médio | c/e | Despacho médio é raro | insumo ou N/A |
| 37 | DOU Despacho grande | c/e | Despacho grande é improvável | N/A justificado, ou insumo |
| 38 | DOU página do jornal (n/a) | d | **M9 (p57 e p58) já está no acervo**; a extração do PDF mistura as colunas | preparação de colunas do PDF DOU |
| 39 | Sefaz-SP RICMS artigo grande | b/e | o coletor oficial é acessível; os 6 artigos coletados têm até 33.383 caracteres | coleta de um artigo ou anexo extenso, ou N/A |
| 40–48 | DOE-SP Decreto, Resolução e Portaria CAT, 3 portes cada | c | P2-d só depois da validação do M9 (frente DOE-SP) | frente DOE-SP |

**Contagem principal:**

| Classe | Células |
|---|---|
| c | 39 (inclui as variantes c/e, c+d e c (a?)) |
| d | 3 (Planalto grande, normas.leg grande, DOU página) |
| b | 3 (normas.leg pequeno e médio, Sefaz-SP grande) |
| a, condicional | 4 (corpus 02, 10, 11 e 07, que dependem de decisão de proveniência ou de layout) |

Nenhuma célula é (a) pura, em que só falte ler.

**Possíveis (e):** 7 células (ADI grande, ADE grande, SC grande, Protocolo grande, Despacho médio, Despacho grande e Sefaz-SP grande). Cada uma precisa de evidência e de decisão própria; o plano não presume que alguma seja inexistente.

## 3. Ciclo único de motor (E9-M2/M3), com a ferramenta E9-M1 à parte

### E9-M1: ferramenta da matriz

Fica em `ops/anatomy/official-coverage-matrix.ts` e **não muda a identidade do motor**.
- Completude e derivação de aceite para fontes não-RFB.
- Definição de `entrySha256` fora do lote RFB (proposta: digest da entrada do `official-samples-baseline.json`).
- Ligar os novos perfis (Planalto, NORMAS-LEG, página DOU) à coleta de amostras.

Sozinha, a E9-M1 não fecha nenhuma célula. É pré-requisito para aceitar qualquer célula CONFAZ, Sefaz-SP, Planalto, normas.leg ou DOU.

### E9-M2/M3: ciclo de motor

Um único ciclo, com uma identidade nova e uma prova de equivalência só.

| Frente | Mudança | Células desbloqueadas para aceite |
|---|---|---|
| M-RFB | Classificar pelo conteúdo os segmentos que a fonte marca com tipo 999: inciso romano sem separador, fórmula de preâmbulo, "DECLARA:" e "RESOLVE:". Mapear o tipo 1000 como assinatura. | IN médio (141910), ADI pequeno (37103), ADE pequeno (148629), Resolução pequeno (122645). Para o ADE médio (148516), só a parte textual; o anexo exige coleta. |
| M-CONFAZ | Delimitar o ato na página Plone; reconhecer ementa, cabeçalhos espaçados e ANEXO ÚNICO com tabela e notas; resolver o `html_complexity_limit` do M3. | Convênio grande (M4), Ajuste SINIEF grande (M5), e depois os insumos CONFAZ |
| M-SEFAZ | Classificar os cabeçalhos de contexto (Livro, Título, Seção), o subtítulo do anexo e o bloco `revogado`. | RICMS pequeno e médio, se o COORD decidir que a limitação de proveniência local não bloqueia |
| M-PLANALTO | Novo perfil Planalto, sobre o charset de fallback aprovado. | Planalto grande (M1/M2) e depois os insumos Planalto |
| M-LEG | Perfil NORMAS-LEG (L-LEG-01), portado dos ramos do #305 e do #309. | normas.leg grande; os registros NORMAS-LEG precisam ser revalidados |
| M-DOUPDF | Preparação da ordem de colunas da página do DOU em PDF. | DOU página (n/a); também libera o gate do P2-d na frente DOE-SP |

**Ganho máximo do ciclo:** até **11 células aceitas a mais**: 8 das 9 já cobertas (o ADE médio ainda depende do anexo) e 3 novas coberturas (Planalto grande, normas.leg grande e DOU página).
- RFB: 4.
- CONFAZ: 2.
- Sefaz-SP: 2 (condicionadas).
- Planalto grande, normas.leg grande e DOU página: 1 cada.

Com isso o total iria de 4 para até 15 de 61. A F1 não muda enquanto a matriz não fechar.

**Risco de equivalência:**
- Qualquer mudança no motor invalida os aceites atuais, que valem só para `4b96f977`. São 5 amostras RFB em 4 células.
- **Todas as 14 amostras RFB do acervo têm segmentos de tipo 999.** As aceitas também: 108391 tem 1, 115131 tem 10, 133898 tem 10, 142967 tem 8 e 148693 tem 1.
- Portanto a frente M-RFB pode mudar as leituras já aceitas. Cada uma precisa de prova formal de equivalência, pela rotina da Portaria 635, e de revalidação append-only.
- Se alguma leitura mudar de verdade, o aceite cai e precisa de nova revisão.
- **Mitigação:**
  - fazer as frentes por fonte, num único PR, com testes de não regressão por fonte;
  - o perfil novo não pode tocar os perfis existentes;
  - comprovar que o lote RFB e o baseline não-RFB não mudam nas amostras fora do alvo.

## 4. Ordem de execução proposta

| Etapa | Conteúdo | Células, estimativa | Depende de |
|---|---|---|---|
| 0 | Decisões sem custo: N/A das 7 possíveis (e); layout XML INLABS para DOU (corpus 07, 10, 11); proveniência do corpus 02 (CV100/97); se a limitação de proveniência Sefaz-SP bloqueia o aceite | 0 a 7 retiradas da grade, mais 0 a 4 cobertas | COORD |
| 1 | E9-M1, a ferramenta da matriz | 0 (pré-requisito) | mandato |
| 2 | Ciclo de motor E9-M2/M3, com revalidação dos 5 aceites RFB | até 11 aceitas: 8 já cobertas + 3 novas (Planalto grande, normas.leg grande, DOU página) | mandato e revisão independente |
| 3 | Corpus já no acervo, se a etapa 0 aprovar | até 4 (DOU IN médio, Portaria médio e Despacho pequeno; CONFAZ Convênio médio) | decisão da etapa 0 |
| 4 | Insumos manuais | até 24: Planalto 2, CONFAZ 6 a 7, DOU 15 a 18 | **Fábio** (arquivos) |
| 5 | Reautorização do P2-c | 9 RFB, mais o anexo do ADE Corat 33/2025 | **Fábio/COORD** (grants e orçamento de requisições) |
| 6 | Coleta acessível | normas.leg pequeno e médio (2); Sefaz-SP grande (1, ou N/A) | mandato de coleta |
| 7 | DOE-SP P2-d | 9 | frente DOE-SP, depois do M9 (etapa 2, M-DOUPDF) |

**Dependências do Fábio:**
- arquivos manuais Planalto (pequeno e médio), CONFAZ (Convênio pequeno, e médio se o corpus 02 não servir; Ajuste pequeno e médio; Protocolo nos 3 portes) e DOU (15 atos em HTML);
- reautorização e orçamento do P2-c para a RFB.

**Caminho crítico para a E9 completa:** etapas 2, 4, 5 e 7. Sem insumos manuais, grants e P2-d, o teto é de cerca de **19 de 61**: 15 pelo motor e até 4 pelo corpus.

## 5. Limites deste plano

- Foi só leitura e medição offline. Usei o motor atual em amostras do acervo, sem coleta e sem tocar em motor, matriz, registros ou flags.
- As medições de porte do corpus (02, 07, 10, 11) são diagnósticas. Todas deram status `partial` e nenhuma conta como cobertura.
- Respeitei a reserva do corpus (04, 06, 08, 09, 12, 14, 16, 18, 24, 28 e as partições `reserved-final`): nenhum desses itens foi lido.
