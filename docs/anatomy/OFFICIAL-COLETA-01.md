# ANAT-OFFICIAL — coleta oficial: identificação de atos (lote 1)

Frente 1, coleta autorizada pelo COORD. Sem corpus, gold ou reserva: cada candidato é conferido contra `RESERVED_ACT_KEYS` e `RESERVED_SOURCE_IDS` (`src/modules/anatomy/config/reserved-act-keys.ts`). Nenhum dos atos abaixo coincide com uma chave ou id reservado. A conferência definitiva é feita pelo gate OFFICIAL-01, quando cada amostra entra.

## Situação dos portais nesta sessão (2026-11-04)

| Portal | Acesso | Observação |
|---|---|---|
| normas.receita.fazenda.gov.br | ✅ | A busca usa a API pública `POST /api/indexacao/ato/pesquisar`. O texto do ato abre em outro host. |
| normasinternet2.receita.fazenda.gov.br | ❌ 403 do proxy do ambiente | Host do texto dos atos da Receita, fora da lista de domínios permitidos. Precisa ser liberado, ou o arquivo salvo manualmente. |
| www.lexml.gov.br | ❌ desafio anti-robô em JavaScript (Senado) | Não será contornado. |
| www.planalto.gov.br · www.confaz.fazenda.gov.br · www.in.gov.br | ❌ a origem recusa a conexão | Precisam de salvamento manual. |

## INs de DCTF identificadas na fonte oficial (RFB)

Evidência: `ops/anatomy/official-identification/rfb-dctf-in-search.json`, resposta da API de busca da Receita para `termo=DCTF`, filtrada por Instrução Normativa (248 resultados). SHA-256 `124bdfcafe61c267b9b9c6eaa1476e6d4880633555432b9e4a3c21313e5f4e1e`, consultada no instante gravado em `rfb-dctf-in-search.consultedAt`. Número, data de publicação e ementa vêm da resposta, não de memória.

| Porte | Ato | idAto RFB | Publicação | Por quê |
|---|---|---|---|---|
| grande | IN RFB 2.005/2021 (DCTF e DCTFWeb) | 115131 | 01/02/2021 | Ato-base com muitas alterações posteriores (2.007, 2.038, 2.048, 2.094, 2.137, 2.162, 2.187, 2.188): redações e notas de alteração |
| médio | IN RFB 2.237/2024 (DCTFWeb) | 141910 | 05/12/2024 | Ato recente, estrutura completa |
| pequeno | IN RFB 1.932/2020 (prorroga prazo da DCTF/EFD-Contribuições) | 108391 | 03/04/2020 | Prorrogação curta: evento temporal |
| pequeno (alteração) | IN RFB 2.162/2023 (altera a 2.005) | 133898 | 06/10/2023 | Alteração parcial com nova redação |

URL de visualização de cada ato: `https://normasinternet2.receita.fazenda.gov.br/#/consulta/externa/<idAto>`.

## Leis de PIS/Cofins e convênios alternativos: dependem de salvamento manual

- **Leis de PIS/Cofins (Planalto):** a identificação do ato e da versão compilada será confirmada no próprio arquivo salvo. Nada é presumido.
- **Convênios alternativos (CONFAZ):** os candidatos do manifesto (Convênio ICMS 142/2018, 190/2017, Ajuste SINIEF 07/2005) e um convênio com anexo de NCM, prorrogações e redações anteriores, a confirmar no arquivo. Todos estão fora do corpus e da reserva (o 52/91 e o 100/97 estão excluídos, D01=A).

## Arquivos recebidos manualmente

Cada arquivo entra com URL, data da consulta, SHA-256 dos bytes recebidos e origem `obtido manualmente pelo Fábio`. Um arquivo salvo manualmente nunca é chamado de "original" sem prova de procedência: fica registrado como **reprodução salva pelo navegador**, que pode diferir dos bytes servidos pelo portal (o navegador reescreve o HTML).
