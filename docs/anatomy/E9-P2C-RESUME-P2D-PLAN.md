# E9 — reconciliação do P2-c, proposta de retomada e plano offline do P2-d (07/11/2026)

**Nada aqui autoriza execução.** P2-c está suspenso com saldo zero; P2-d está parado até o gate de M9.

## 1. Reconciliação do excedente (registro por adendo; registros anteriores preservados)

| | Requisições |
|---|---|
| Limite aprovado do pacote P2-c (#116 c.6701950134) | **25** |
| Sessão 1 (EXEC do #303) | **19** |
| Sessão 2 (outra sessão, #303 c.6702168770) | **9** |
| **Total combinado** | **28** |
| **Excedente** | **3** |
| **Saldo disponível** | **0** |
| Situação | **P2-c suspenso** |

**Inventário por requisição:** `ops/anatomy/official-identification/rfb-p2c/ledger-combined.json`.
- **Sessão 1:** 19 linhas, cada uma com horário, finalidade, tipo de ato, URL sanitizada, resposta, redirecionamentos e captura (do registro próprio `inventory.json`).
- **Sessão 2:** 9 linhas com o que foi **informado** (4 arquivos públicos de descoberta do SPA + 1 consulta por categoria; nenhuma captura; 5 respostas iguais ao shell do SPA).
- **Lacunas declaradas:** horário, URL, resposta e redirecionamentos de cada requisição da sessão 2 não foram publicados (pedido em #303 c.6702214892). A categoria das 4 requisições de descoberta também não foi informada. Todas contam no pacote: requisição sem captura não é descontada.

**Causa comprovada:** a sessão 2 consultou sem conferir o registro publicado pela sessão 1, como ela mesma declarou, e as duas consumiram o mesmo pacote sem reserva prévia. Nenhuma outra causa ou responsabilidade é afirmada.

**Prevenção (implementada no código):**
1. **Responsável único** pelo consumo do pacote: o EXEC dono do #303.
2. **Inventário compartilhado único:** `ledger-combined.json`, versionado no #303, é a única fonte do saldo.
3. **Reserva prévia:** antes de cada conjunto de consultas, um commit registra a reserva (quantidade, finalidade, responsável).
4. **Guarda no coletor:** `collect-p2c.ts` chama `assertReservation()` antes de qualquer requisição e **recusa** com saldo ≤ 0, com situação "suspenso" ou sem uma reserva que caiba no saldo. Teste: com o ledger atual, zero chamadas de rede.

## 2. P2-c: o que fica pendente e a proposta de retomada

**Pode ser concluído com os arquivos existentes? Não.**
- As buscas gravadas (`search-*.json`) só trazem ementa, sem tamanho. Os atos médios e grandes conhecidos (por exemplo, a Resolução CGSN 140/2018 consolidada) só aparecem como **referência** em ementas de alteração, sem idAto.
- As capturas descartadas eram pequenas, e os bytes não foram guardados, por regra.

**Células RFB pendentes (12):** Portaria × médio e grande; ADI × médio e grande; Resolução × médio e grande; ADE × pequeno, médio e grande; Solução de Consulta × pequeno, médio e grande.

**Proposta de orçamento fechado (para decisão; teto de 16 requisições):**

| Tipo | Consulta proposta | Justificativa verificável | Máximo |
|---|---|---|---|
| Resolução m/g | 1 busca direcionada "Resolução CGSN nº 140" + 2 capturas | A 140/2018 é a consolidação do Simples, citada em `search-resolucao.json` (ementas 183/2025 etc.) | 3 |
| Portaria m/g | 1 busca direcionada (portaria de regimento ou de consolidação) + 2 capturas | Todas as portarias da busca atual são "Altera…" (pequenas) | 3 |
| ADI m/g | 2 capturas, sem busca: 148121 ("Dispõe sobre a interpretação dos art. 605 a 608…", 2025) e mais um candidato da busca gravada | O candidato está em `search-adi.json`; ADIs costumam ser pequenos, e o resultado pode ser "não encontrado" | 2 |
| ADE p/m/g | **(a)** 3 capturas de atos de 2026 **não reservados** da busca gravada; ou **(b)** 1 busca com filtro de ano + 3 capturas | `search-ade.json`: os 32 ADEs são de 2026 (a lista de reservados cobre ade 79/119/120/26) | 3 ou 4 |
| Solução de Consulta p/m/g | (a) ou (b), como no ADE | `search-sc*.json`: 98 de 100 resultados são de 2026 | 3 ou 4 |
| **Total** | | | **14 a 16** |

- **Responsável único:** o EXEC do #303. A reserva é registrada antes, com o número exato.
- **Parada:**
  - em cada célula, no primeiro ato mantido ou depois das tentativas previstas;
  - em cada tipo, no máximo da tabela;
  - no total, em 16;
  - falha de rede conta e não abre retry fora do teto;
  - "não encontrado" nunca vira "inexistente".
- **Decisão pedida:** aprovar ou ajustar o teto; escolher (a) ou (b) para ADE/SC.

## 3. P2-d / DOE-SP: plano offline (não executar)

**Gate:** só depois da validação de M9. Hoje o M9 tem só a identidade validada (PDF da página 57: cabeçalho, rodapé e epígrafe; alcance E4). A anatomia em HTML não foi validada: o HTML retornou 403, e a página 58 ainda não chegou aqui. **O recebimento do PDF não cumpre o gate. O P2-d fica parado.**

**Bloqueio adicional:** a API v2 do DOE-SP (`do-api-web-search.doe.sp.gov.br`, usada pelo conector `src/modules/collection/doe-sp.client.ts`) **não está** nos hosts oficiais do gate OFFICIAL-01. O gate aceita `legislacao.fazenda.sp.gov.br` e `www.doe.sp.gov.br`. Executar P2-d pela API v2 exige decidir a inclusão desse host no gate, ou usar o HTML oficial de `www.doe.sp.gov.br`.

**Alvos e critérios (do escopo aprovado, c.6701950134 §4):**
- Decreto, Resolução e Portaria CAT; até 1 caso por porte disponível, máximo 9 atos e 15 requisições, até 5 por tipo.
- Mesmas proteções do P2-c, incluindo reserva prévia no ledger e responsável único.
- Antes de qualquer captura, conferir a lista de reservados: ela contém atos DOE-SP de 2026, como `decreto 70843/26`, `portaria 43/26`, `resolucao 86/26` e `portaria 12157/26`. Manter a margem de 2026.
- Somente captura offline. Sem coletor produtivo, bootstrap, recaptura, scheduler ou SQL.
- **Resultado esperado por amostra:** captured → identified (número e data no título) → read (perfil DOE-SP próprio) → validated (invariantes + baseline). Nada promovido; o aceite é do COORD.
