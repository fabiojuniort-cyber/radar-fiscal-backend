# XMLs oficiais INLABS, 2026-09-18

Origem: ZIPs DO1 e DO1E baixados pelo titular no INLABS e enviados para validação do Radar Fiscal em 2026-09-21. São 12 entradas extraídas sem alteração dos bytes (inclusive BOM/CRLF), não o conteúdo integral dos ZIPs. `manifest.json` preserva SHA-256 de cada XML e do ZIP original.

- Normal original: `4333ca101c8aec328fcb3e31fc38a70efbeeba79d148014ac4cc34f263e41093`.
- Extra original: `cce7d9dc02a31c531b087ef4cf325f9251a2d4d8d86fb371e6d2c86b31b94bc7`.
- Downloads: `https://inlabs.in.gov.br/index.php?p=2026-09-18&dl=2026-09-18-DO1.zip` e equivalente `DO1E.zip`, com sessão autenticada.

Casos: retificação, atos declaratórios COANA, solução de consulta, três despachos da Fazenda com a mesma página certificada, portaria em três partes, IN RFB e portaria da Saúde. Não há amostra CONFAZ nestes pacotes.

`dou.fixtures.ts` verifica hashes e recria contêineres ZIP determinísticos para HTTP simulado. Esses contêineres não são os ZIPs integrais oficiais. O teste de nova versão modifica explicitamente um único texto em memória; as fixtures reais não são alteradas. Cabeçalhos CONFAZ sintéticos validam apenas a taxonomia.

O XML não substitui a versão certificada; `pdfPage` preserva a referência observada. Nenhum cookie ou dado de conta está incluído.
