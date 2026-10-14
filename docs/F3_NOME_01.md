# F3-NOME-01 — Nome do ato

Base congelada: `b134e363de6d29c589420278547278a7ceacdbef`. Governança: tribusca-control#108.

`collectionFilterActName` é a única função que extrai Nome do ato. Usa a primeira linha do título, corta número/identificador, data, `, DE`, complemento após hífen separado e parênteses; remove o identificador final órgão-UF (ex.: PGE-SP) e apresenta caixa de título com partículas em minúsculas. O tipo oficial permanece como metadado/proveniência, sem participar da seleção da regra. O corpo continua disponível para os gates tributários dos modos condicionais.

O motor usa prefixo por palavra inteira, maior quantidade de palavras e empate favorável a MANTER. Regras, aliases, modos e revisão persistidos não são regravados. A chave antiga da regra permanece como identidade; seu padrão em memória é o Nome do ato. Colisões novas de normalização não apagam regras e mantêm o desempate conservador. Inconsistência de proveniência continua preservando; EXCLUDE_ALWAYS e os bloqueios empresa/match/outra origem continuam nos caminhos existentes.

## Fila e contrato web

`GET /state` acrescenta `actName` nas regras/aliases/termos e `actNames` com Nome, fonte, seção e contagem. `GET /new-types?status=OPEN` reorganiza a fila por uma projeção de leitura do acervo DOU/DOE-SP sob o mesmo motor: somente Nomes sem casamento entram na fila. `occurrence_count` conta publicações distintas por fonte/seção/Nome, sem extrapolar as até três amostras. Não representa repetições de coleta nem documentos já apagados. Contador do estado e listagem usam a mesma função. Não há migration, INSERT/UPDATE da fila ou criação de regras para essa reorganização.

Entradas derivadas identificam `queue_basis=ARCHIVE_ACT_NAME` e têm ID estável de apresentação. O web não envia esse ID como `newTypeId` persistido; classifica pela regra e mescla pela operação ALIAS_PUT existente. Linhas antigas e o histórico de resolução permanecem intocados. Clientes antigos podem falhar de forma fechada ao tentar classificar um ID da projeção durante o intervalo entre backend e web; não há resolução silenciosa de um ID inexistente.

Prévias diretas acrescentam `actName` e amostras com esse campo. A prévia global agrupa contagens por Nome real e regra vencedora. Tokens incluem a versão semântica F3-NOME-01 para invalidar prévias anteriores, mesmo sem alterar a revisão salva. O SQL de purge permanece sem classificador paralelo e continua revalidando revisão, locks e proteções. Nenhuma exclusão é executada por esta alteração ou por sua leitura.

## Impacto e limites

`node --import tsx ops/f3-nome-01/impact.ts [snapshot-politica.json] [saida.json]` compara o mesmo documento de política no motor congelado da base e no motor novo, sem acesso a banco/rede. O relatório versionado `f3-nome-01-impact.json` usa dez fixtures sintéticas: 5 MANTER→DESCARTAR e 2 DESCARTAR→MANTER. Lista nomes, títulos, regras e motivos antes/depois.

**NOT_PROVEN:** não foi fornecido/encontrado snapshot versionado da revisão produtiva atual. Esses números não são impacto certificado da política/acervo em produção. O script aceita um snapshot offline para refazer a comparação; não consulta produção para obtê-lo. Mesmo com snapshot, o resultado continua limitado ao corpus de fixtures informado.

Fase 1 exige CI verde e entrega ao COORD antes de qualquer merge. Fase 2 somente no SHA aprovado, com health, um ciclo sem erro novo e smoke apenas de leitura/prévia. Sem salvar regras, confirmar exclusões, apagar publicações ou publicar taxonomia. #111 permanece suspenso e intocado. Reversão por deployment anterior, sem migration ou alteração destrutiva de dados.
