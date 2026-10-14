# F3-NOME-02 — impacto com regras de produção e títulos oficiais

Política exportada pelo Fábio: revisão **225**, **2.352 regras**, **75 termos**, sem aliases. SHA-256 do anexo: `6062be2acb27d87ff7e5bae43b81843c209b4b730df12d82723a24cbc4099f32`. O arquivo foi preservado byte a byte, sem salvar regras no painel.

Comparação offline do motor anterior congelado em `b134e363de6d29c589420278547278a7ceacdbef` com o motor corrigido do PR #227. Corpus: **3.958 publicações distintas por URL oficial**, sendo **2.265 DOU/DO3 em 14/10/2026** e **1.693 DOE-SP/Atos Normativos em 09, 13 e 14/10/2026**. Fonte DOU: documento público `https://www.in.gov.br/leiturajornal?data=14-10-2026&secao=do3`, lido pelo navegador oficial (HTTP automatizado retornou 403). DOE-SP: APIs oficiais `v2/summary/list` e `v2/summary/filters`. URLs, horários e hashes das respostas constam de `public-corpus.json`; o export DOM do DOU está em `dou-titles.json`.

| Fonte | Títulos | MANTER → DESCARTAR | DESCARTAR → MANTER |
|---|---:|---:|---:|
| DOU | 2.265 | 55 | 256 |
| DOE-SP | 1.693 | 0 | 0 |
| Total | 3.958 | **55** | **256** |

**Limite da prova:** corpus de títulos e tipos oficiais, sem corpos completos. `evidenceComplete=false` em ambos os motores; modos condicionais conservam MANTER quando falta evidência. Os 55 novos descartes decorrem de EXCLUDE_ALWAYS no motor novo, e vários eram condicionais no anterior. Estes são números reproduzíveis para o corpus fornecido, não previsão de exclusões do acervo produtivo nem certificação do resultado com corpos completos. Não há evidência de vínculo empresa/match/outra origem nesta amostra pública. Nenhuma exclusão foi executada. Amostra recente de conveniência, não aleatória nem representativa de todas as seções/datas.

Reprodução (sem rede/banco):

```bash
node --import tsx ops/f3-nome-01/impact.ts docs/f3-nome-02/regras-producao.json docs/f3-nome-02/impact-real.json docs/f3-nome-02/public-corpus.json
```

O relatório JSON inclui todos os 311 casos que mudaram e a lista explícita `keepToDiscardList` com os 55 MANTER → DESCARTAR, URLs e regras/motivos antes/depois. CI recalcula e compara o relatório integral com os arquivos congelados.

## Lista completa — MANTER → DESCARTAR

| # | Título oficial | Regra anterior | Regra nova |
|---|---|---|---|
| 1 | [EXTRATO DE CONTRATO Nº 9/2026](https://www.in.gov.br/web/dou/-/extrato-de-contrato-n-9/2026-738178555) | EXTRATO DE NOTA DE EMPENHO | EXTRATO DE CONTRATO |
| 2 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738203225) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 3 | [AVISO DE INEXIGIBILIDADE DE LICITAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-inexigibilidade-de-licitacao-738265971) | EXTRATO DE INEXIGIBILIDADE DE LICITACAO | AVISO DE INEXIGIBILIDADE DE LICITACAO |
| 4 | [EDITAL de 13 de outubro de 2026](https://www.in.gov.br/web/dou/-/edital-de-13-de-outubro-de-2026-738289452) | EDITAL DE CONVOCACAO | EDITAL |
| 5 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738211214) | EXTRATO DE TERMO DE ENTREGA | EXTRATO DE CONTRATO |
| 6 | [AVISO DE DISPENSA DE LICITAÇÃO Nº 3/2026](https://www.in.gov.br/web/dou/-/aviso-de-dispensa-de-licitacao-n-3/2026-738265094) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE DISPENSA DE LICITACAO |
| 7 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738265892) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 8 | [EXTRATO DE TERMO ADITIVO](https://www.in.gov.br/web/dou/-/extrato-de-termo-aditivo-738303858) | EXTRATO DE INSTRUMENTOS CONTRATUAIS | EXTRATO DE TERMO ADITIVO |
| 9 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738163989) | EXTRATO DE TERMO DE ENTREGA | EXTRATO DE CONTRATO |
| 10 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738203724) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 11 | [edital de 13 de outubro de 2026](https://www.in.gov.br/web/dou/-/edital-de-13-de-outubro-de-2026-738244096) | RETIFICACAO | EDITAL |
| 12 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738187881) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 13 | [EDITAL DE COMUNICADO DE COBRANÇA ADMINISTRATIVA Nº 1/2026 - UASG 927487](https://www.in.gov.br/web/dou/-/edital-de-comunicado-de-cobranca-administrativa-n-1/2026-uasg-927487-738149561) | EDITAL DE NOTIFICACAO | EDITAL |
| 14 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738147576) | EXTRATO DE TERMO DE ENTREGA | EXTRATO DE CONTRATO |
| 15 | [AVISO de ADJUDICAÇÃO e HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738234880) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 16 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738278188) | EXTRATO DE CONCESSAO DE USO | EXTRATO DE CONTRATO |
| 17 | [Aviso de Inexigibilidade de licitação](https://www.in.gov.br/web/dou/-/aviso-de-inexigibilidade-de-licitacao-738301688) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE INEXIGIBILIDADE DE LICITACAO |
| 18 | [EDITAL Nº 7/2026, DE 13 DE OUTUBRO DE 2026](https://www.in.gov.br/web/dou/-/edital-n-7/2026-de-13-de-outubro-de-2026-738160024) | EDITAL DE CONVOCACAO | EDITAL |
| 19 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738174228) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 20 | [EDITAL](https://www.in.gov.br/web/dou/-/edital-738207706) | EDITAL DE CONCURSO PUBLICO | EDITAL |
| 21 | [EDITAL Nº 3, DE 8 DE OUTUBRO DE 2026](https://www.in.gov.br/web/dou/-/edital-n-3-de-8-de-outubro-de-2026-738193985) | AVISO | EDITAL |
| 22 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738130990) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 23 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738161709) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 24 | [edital](https://www.in.gov.br/web/dou/-/edital-738168535) | RETIFICACAO | EDITAL |
| 25 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738171856) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 26 | [EXTRATO DE CONTRATO DE COMODATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-de-comodato-738178160) | EXTRATO DE COMODATO | EXTRATO DE CONTRATO |
| 27 | [EXTRATO DE TERMO ADITIVO](https://www.in.gov.br/web/dou/-/extrato-de-termo-aditivo-738222773) | EXTRATO DE INSTRUMENTOS CONTRATUAIS | EXTRATO DE TERMO ADITIVO |
| 28 | [EDITAL DE 13 DE OUTUBRO DE 2026](https://www.in.gov.br/web/dou/-/edital-de-13-de-outubro-de-2026-738243906) | EXTRATO | EDITAL |
| 29 | [EXTRATO DE CONTRATO Nº 10/2026](https://www.in.gov.br/web/dou/-/extrato-de-contrato-n-10/2026-738296340) | EXTRATO DE NOTA DE EMPENHO | EXTRATO DE CONTRATO |
| 30 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738236602) | EXTRATO DE TERMO DE ENTREGA | EXTRATO DE CONTRATO |
| 31 | [EDITAL DE 13 DE OUTUBRO DE 2026](https://www.in.gov.br/web/dou/-/edital-de-13-de-outubro-de-2026-738150518) | EDITAL DE PROCESSO SELETIVO | EDITAL |
| 32 | [EDITAL DE 13 DE OUTUBRO DE 2026](https://www.in.gov.br/web/dou/-/edital-de-13-de-outubro-de-2026-738198327) | EXTRATO | EDITAL |
| 33 | [AVISO DE ADJUDICAÇÃO e HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738148246) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 34 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738189708) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 35 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738235228) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 36 | [edital de 13 de outubro de 2026](https://www.in.gov.br/web/dou/-/edital-de-13-de-outubro-de-2026-738250532) | RETIFICACAO | EDITAL |
| 37 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738263752) | EXTRATO DE CONCESSAO DE USO | EXTRATO DE CONTRATO |
| 38 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738284705) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 39 | [EDITAL](https://www.in.gov.br/web/dou/-/edital-738271088) | RETIFICACAO | EDITAL |
| 40 | [EDITAL DE 15 DE JUNHO DE 2026](https://www.in.gov.br/web/dou/-/edital-de-15-de-junho-de-2026-738154189) | RESULTADO DE JULGAMENTO | EDITAL |
| 41 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738214610) | EXTRATO DE CONCESSAO DE USO | EXTRATO DE CONTRATO |
| 42 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738278265) | EXTRATO DE CONCESSAO DE USO | EXTRATO DE CONTRATO |
| 43 | [EDITAL Nº 60, DE 8 DE OUTUBRO DE 2026](https://www.in.gov.br/web/dou/-/edital-n-60-de-8-de-outubro-de-2026-738164673) | EDITAL DE CONVOCACAO | EDITAL |
| 44 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738165218) | EXTRATO DE TERMO DE ENTREGA | EXTRATO DE CONTRATO |
| 45 | [EDITAL DE 9 DE OUTUBRO DE 2026](https://www.in.gov.br/web/dou/-/edital-de-9-de-outubro-de-2026-738184266) | RETIFICACAO DE EDITAL | EDITAL |
| 46 | [Edital Nº 13/2026/SEOP-SC](https://www.in.gov.br/web/dou/-/edital-n-13/2026/seop-sc-738223495) | EDITAL DE NOTIFICACAO | EDITAL |
| 47 | [Aviso de Adjudicação e Homologação](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738256766) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 48 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738263678) | EXTRATO DE CONCESSAO DE USO | EXTRATO DE CONTRATO |
| 49 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738139296) | EXTRATO DE TERMO DE ENTREGA | EXTRATO DE CONTRATO |
| 50 | [EXTRATO DE CONTRATO](https://www.in.gov.br/web/dou/-/extrato-de-contrato-738150849) | EXTRATO DE CONCESSAO DE USO | EXTRATO DE CONTRATO |
| 51 | [aviso DE Dispensa de Licitação nº 25/2025](https://www.in.gov.br/web/dou/-/aviso-de-dispensa-de-licitacao-n-25/2025-738204120) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE DISPENSA DE LICITACAO |
| 52 | [AVISO DE INEXIGIBILIDADE DE LICITAÇÃO Nº 25/2026](https://www.in.gov.br/web/dou/-/aviso-de-inexigibilidade-de-licitacao-n-25/2026-738216190) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE INEXIGIBILIDADE DE LICITACAO |
| 53 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738255733) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 54 | [AVISO DE ADJUDICAÇÃO E HOMOLOGAÇÃO](https://www.in.gov.br/web/dou/-/aviso-de-adjudicacao-e-homologacao-738255656) | AVISO DE HOMOLOGACAO E ADJUDICACAO | AVISO DE ADJUDICACAO E HOMOLOGACAO |
| 55 | [EDITAL DE 13 de outubro de 2026](https://www.in.gov.br/web/dou/-/edital-de-13-de-outubro-de-2026-738280915) | RETIFICACAO | EDITAL |
