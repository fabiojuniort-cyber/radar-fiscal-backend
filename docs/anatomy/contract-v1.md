# ANAT → TAX v1

Origem: CLAUDE-COORD → GPT-EXEC, ANAT-04 R2, issue de coordenação [#116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116). Este contrato implementa a primeira entrega do pacote; não integra o classificador, detector NCM, cadastros ou taxonomia existentes.

## Verificação

Versão: `ANAT-TAX/1.0.0`. A definição executável está em `src/modules/anatomy/contract.ts`. `anatomyResultShapeSchema` define a forma estrita e exporta o JSON Schema 2020-12 em `contract-v1.schema.json`. `validateAnatomyResult(value)` também verifica invariantes semânticas: somente validar JSON Schema **não basta** para aceitar um resultado. O consumidor simulado deve chamar a validação completa e falhar de modo fechado.

Execute `node node_modules/tsx/dist/cli.mjs --test test/anatomy.contract.unit.test.ts` e `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`. Nenhum teste deste contrato conecta a banco ou serviço. Testes de contrato não são as medições do corpus e não representam aceite das metas de precisão/recall.

## Entrada, identidade e reprodução

`canonicalText` preserva exatamente os caracteres interpretados, incluindo acentos, marcas combinantes, espaços e caracteres suplementares. Não aplicar NFC, remoção de acentos, expansão de prefixos nem reparação numérica. Texto derivado de HTML tem que declarar sua transformação no perfil versionado e mapear cada intervalo de volta ao recurso recebido. Hash de texto é SHA-256 dos bytes UTF-8 desse texto exato.

`identity` registra versão da publicação, representação, hash do texto, hash da apresentação (nulo apenas se ausente), hash do manifesto de anexos e versões/hashes do motor, regras e contrato. O manifesto de anexos deve ser congelado, ordenado e explícito, inclusive quando vazio. `analysisId = SHA256(canonicalJson(identity))`; mudar só a apresentação também muda a identidade. Não reutilizar aprovação de outra representação ou snapshot.

`outputHash` é SHA-256 da serialização canônica do objeto inteiro, exceto o próprio `outputHash`. Chaves de objetos são ordenadas; arrays mantêm ordem semântica. Dados são JSON finito, sem `undefined`, datas como objetos ou atributos executáveis. Relógio de execução não entra no resultado: `reviewedAt` descreve a aprovação congelada da fixture, não a hora de rodar o motor. Mesma entrada, referência, evidências, regras e motor produzem o mesmo resultado. A identidade técnica não é uma concessão de acesso; autorização e RLS existentes não são substituídas por este contrato.

## Árvore, origem e cobertura

Todos os spans usam índices **UTF-16**, início inclusivo e fim exclusivo, como `String.slice` do JavaScript. Não dividir um par substituto de emoji. Um par composto por letra e marca combinante pode ter dois índices e nunca é normalizado silenciosamente.

Há uma raiz `document` que cobre todo o texto. Pais precedem filhos; irmãos são ordenados por posição, sem sobreposição, com `order` contíguo a partir de zero. Filhos ficam dentro do pai. IDs são locais à anatomia e referências externas a outra análise não são aceitas. Containers podem incluir filhos; isso não duplica cobertura.

`sourcePointers` preservam recurso, formato, localizador e, quando conhecido, span da origem. `sourceMap` particiona todo o texto canônico em intervalos ordenados e aponta cada um à representação recebida. Os índices `sourceSpan` são locais ao recurso, também UTF-16; a correspondência pode ter comprimentos diferentes por entidades HTML, marcação ou separadores documentados. Ponteiro não inventa recuperação de imagem/OCR ou anexo ausente. Limites de recursos originais são responsabilidade da preparação da entrada, pois os bytes originais não estão duplicados no resultado.

`coverage.segments` é uma partição de propriedade exclusiva do texto, sem lacunas nem duplicações. Cada segmento pertence a uma parte e é `recognized` ou `unidentified`. `accountedLength` deve ser o comprimento integral, mesmo em resultado parcial; `recognizedLength` conta apenas segmentos reconhecidos. Texto desconhecido preservado conta para cobertura, mas **não conta como acerto** de estrutura. Falha, anexo ausente, limitação ou parte não identificada impedem `status=complete`. O resultado deve conservar o que foi recebido e declarar `partial`/`failed`, nunca transformar ausência em completude.

Tabelas preservam partes `table`/`row`/`cell`, índices, `rowSpan`, `columnSpan` e a origem da geometria (`original`, `uniquely_reconstructed` ou `unknown`). A forma não autoriza inventar uma grade: o leitor deve emitir desconhecido/parcial diante de ambiguidade. Vários spans podem apontar ao mesmo DOM, mas o texto canônico continua contabilizado uma única vez.

## Três camadas separadas

1. `entities`: ocorrências com literal exato, span, domínio, normalização, regra, confiança e validação. `valid` por formato não equivale a confirmação de catálogo. Validação por catálogo exige edição explícita. NCM de dois dígitos só pode ser `informative`; de quatro a oito inclui cinco e sete, preservando zeros iniciais. Lei, CNPJ, CEP, processo, data, CNAE, CFOP e outros domínios têm identidade própria. `NCM_RANGE` e `NCM_EXCEPTION` conservam operadores compostos, relações, escopo e condições; seus membros não são seleções positivas independentes. Expansão não pode ser inferida por prefixo comum.
2. `parts.context`, `contextReasons` e `legalStatus`: contexto estrutural/documental e situação jurídica separados. Cor, classe CSS ou ausência de classe histórica não concedem `legalStatus=current`. Uma ocorrência em contexto histórico, proibido ou desconhecido permanece reconhecível, mas fora da seleção positiva. A restrição vale também para ancestrais.
3. `eligibility`: decisões explícitas por parte/ocorrência/span, com evidências e motivos de exclusão. Positiva exige resultado completo, contexto permitido, parte corrente e evidência aprovada que cubra exatamente o alvo, na identidade e data de referência corretas, com dependências ainda correspondentes e válidas. O campo obrigatório purpose separa thematic_text de ncm. thematic_text exige entityId nulo e pode conservar texto relevante com citações, faixas ou exceções, sem exportar esses números como NCM. ncm exige entityId não nulo, NCM válido de catálogo, sem operador composto ou domínio protegido sobreposto e sem capítulo de dois dígitos. Consumidores não podem extrair NCM do canal thematic_text; códigos só vêm do canal ncm validado. Containers não podem selecionar descendentes históricos, proibidos, desconhecidos ou sem situação corrente. Evidência aprovada contraditória e sobreposta bloqueia a seleção mesmo quando não foi explicitamente citada. Seleção negativa exige ao menos um motivo. Exemplos de códigos de motivo: `historical_context`, `prohibited_zone`, `unknown_legal_status`, `missing_approved_evidence`, `invalid_catalog_code`, `range_member`, `exception_scope`, `missing_attachment`.

Neste ANAT-04, `evidence.origin` aceita exclusivamente `controlled_fixture` e `approval=approved`. Isso torna a aprovação sintética explícita e verificável; não carrega nem aplica o dossiê ANAT-03. Não há evidência real de produção nesta versão de teste. A carga e aplicação do dossiê dependem de ANAT-06 e novo escopo. As duas ocorrências históricas de 8450.11.00 não podem adquirir elegibilidade por existirem no catálogo ou no HTML.

Evidências têm revisor, data de conferência, fundamento, link, intervalo, referência e hash da identidade. Cada dependência conserva hash aprovado e hash observado, início dos efeitos e fim de validade. Divergência, expiração ou data futura invalidam a seleção dependente; aprovação jamais é inferida da extração. O consumidor deve consumir somente o contrato validado e não chamar a classificação real.

## Limites desta primeira entrega

Não há leitor, motor, consumidor, endpoint, persistência nem DDL nesta entrega. Não há acesso externo, escrita em banco ou alteração de fonte. Os próximos checkpoints acrescentam implementações isoladas e testes; as metas quantitativas ficam bloqueadas até corpus completo congelado e anotação revisada independentemente pelo GPT Astra, preservando as dez publicações reservadas. Administração de regras é ANAT-05; produção e merge exigem autorização separada do COORD.
