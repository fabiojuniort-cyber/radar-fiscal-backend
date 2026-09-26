# DOE-SP — gate para conteúdo HTML oficial como fonte principal

## Status

Documento de preparação técnica. **Não altera comportamento produtivo.**

A decisão global de produto está em `tribusca-control` como D-017: conteúdo completo e fiel publicado em página oficial pode ser coletado diretamente; PDF redundante não é requisito de captura e sua falha isolada não pode bloquear a publicação.

## Estado atual

O conector DOE-SP já usa o HTML oficial do detalhe da publicação como `content`.

O bloqueio está no modelo de versão: `normalizePublication()` inclui o `rawSha256` de todos os `files` em `contentHash`. Portanto:

- mesmo ato + mesmo HTML + PDF autenticado => hash A;
- mesmo ato + mesmo HTML + PDF autenticado indisponível => hash B;
- A e B são diferentes;
- a persistência pode criar `NEW_VERSION` artificial ao reapresentar o mesmo ato sem o PDF redundante.

Os testes adicionados nesta branch tornam essa incompatibilidade explícita sem mudar a produção.

## Classificação desejada para DOE-SP

### Conteúdo canônico

- título e metadados oficiais;
- texto integral do HTML/JSON oficial;
- URL oficial;
- identificador oficial;
- código/referência de autenticidade quando disponível.

### Artefato de proveniência redundante

`AUTHENTICATED_PUBLICATION_PDF` quando reproduz integralmente o conteúdo já disponível no HTML.

Deve poder ser preservado por origem, mas sua indisponibilidade isolada não deve bloquear a publicação nem criar uma versão normativa nova.

### Anexo material

`ATTACHMENT` quando contém texto, tabela, lista ou outra informação necessária que não está integralmente no HTML.

Esse material deve continuar participando da semântica de conteúdo/versionamento.

## Compatibilidade legada necessária

Produção já possui versões DOE-SP cujo `contentHash` foi calculado com PDFs autenticados. Por isso, excluir esses PDFs do hash sem uma camada de compatibilidade faria replays antigos parecerem novas versões.

A implementação da política D-017 deve parar antes de mudar o hash até existir decisão explícita sobre uma destas estratégias:

1. **Hash v2 + compatibilidade v1 (preferida):**
   - hash canônico usa HTML + vigência + anexos materiais;
   - PDF autenticado redundante fica fora do hash;
   - persistência reconhece uma versão v1 existente como semanticamente equivalente ao v2 quando a diferença é somente o PDF redundante;
   - nenhuma origem recebe o PDF de outra origem.

2. **Manter hash v1 + reconciliação especial:**
   - preserva o modelo atual;
   - exige continuar com regras especiais de equivalência para PDF indisponível;
   - fica menos alinhado à D-017.

3. **Duplicar publicação/origem como identidade separada:**
   - evita alterar versionamento;
   - cria duplicidade da mesma norma;
   - não recomendado.

## Gate para implementação

Antes de alteração produtiva, exigir:

- replay de versão legada sem `NEW_VERSION` artificial;
- mesma identidade e mesmo HTML com PDF disponível/indisponível resultando na mesma versão normativa;
- PDF de uma origem nunca atribuído a outra;
- anexos materiais continuando a alterar versão;
- URL e referência de autenticidade preservadas;
- captura integral apenas quando a página oficial for realmente completa;
- CI completo e revisão independente.

Issue de governança: `tribusca-control#1`.
Política global/inventário: `tribusca-control#6`.


## Implementação aprovada — DOE-SP-22

A opção A foi aprovada pelo Gerente. A implementação usa opt-in por publicação, sem alterar o comportamento dos demais conectores.

### Hash novo (v2)

O opt-in v2 só é usado quando o detalhe oficial fornece texto HTML normalizado. Sem HTML canônico, a publicação não é tratada como HTML-primary e a compatibilidade v1→v2 não é presumida.

Para publicações DOE-SP com `contentHashPolicy = HTML_PRIMARY_MATERIAL_FILES`:

```text
sha256(JSON.stringify({
  version: 2,
  title,
  contentText,
  effectiveOn,
  materialFileHashes
}))
```

`materialFileHashes` contém somente SHA-256 de arquivos com papel de conteúdo material. No DOE-SP:
- `ATTACHMENT` => `MATERIAL_CONTENT`;
- `AUTHENTICATED_PUBLICATION_PDF` => `PROVENANCE` quando o HTML oficial está presente e é a representação canônica;
- se o HTML estiver ausente/incompleto a ponto de o PDF ser necessário como fonte material, ele não pode ser descartado do versionamento como mera proveniência.

Uma página com anexo material próprio é marcada `PARTIAL_OFFICIAL_CONTENT`: o HTML sozinho não representa a captura integral. O item só é concluído quando os anexos materiais necessários forem capturados; falha nesses anexos mantém o item/dia incompleto.

O PDF autenticado redundante permanece no metadata da origem, mas fica fora do metadata/hash da versão v2.

### Compatibilidade v1 sem reescrita histórica

Uma versão atual v1 pode ser reutilizada por um replay v2 somente quando todos os critérios são demonstrados:
1. mesmo `publication_id` obtido pela identidade normal do sistema;
2. título canônico exatamente igual;
3. texto canônico exatamente igual;
4. vigência igual, inclusive ausência;
5. hashes dos anexos `ATTACHMENT` legados exatamente iguais aos arquivos materiais recebidos;
6. todos os arquivos legados possuem classificação conhecida (`AUTHENTICATED_PUBLICATION_PDF` ou `ATTACHMENT`) e SHA-256 válido;
7. o `content_hash` v1 persistido pode ser **reconstruído exatamente** a partir do título, texto, vigência e hashes de todos os arquivos legados e coincide com o valor armazenado.

A identidade normativa, isoladamente, nunca é evidência suficiente. Se qualquer arquivo legado tiver classificação desconhecida, hash ausente, o hash v1 não puder ser reproduzido, título/texto/vigência divergirem ou anexos materiais forem diferentes, a compatibilidade não é presumida e o fluxo normal de versionamento permanece explícito como `NEW_VERSION`.

A equivalência nunca altera `content_hash`, `source_metadata` ou arquivos da versão histórica. Ela apenas evita uma versão artificial no replay. O caminho cobre legado com e sem PDF autenticado; um PDF capturado posteriormente continua pertencendo somente à origem que efetivamente o forneceu.

### Proveniência por origem

O contrato e o normalizador distinguem:
- `metadata`: material canônico da versão;
- `originMetadata`: evidência observada exclusivamente naquela origem.

No DOE-SP ficam em `originMetadata`:
- `authCode`;
- estado `authenticatedPdf`;
- `authenticatedPdfError`;
- o arquivo `AUTHENTICATED_PUBLICATION_PDF`, quando efetivamente capturado.

Esses campos não participam do metadata/hash da versão v2. Um PDF autenticado disponível fica somente na origem que efetivamente o forneceu. Uma origem com PDF 404 mantém URL, referência de autenticidade e diagnóstico da falha, sem receber arquivo de outra origem.

O teste ponta a ponta com os IDs observados da Portaria SRE 42/2025 exige duas origens oficiais, uma única publicação, uma única versão v2, nenhuma versão artificial no replay e nenhum empréstimo de PDF entre origens.


## DOE-SP-24 — política page-first vigente

Esta seção substitui a interpretação anterior de que o PDF autenticado redundante poderia continuar sendo baixado por padrão como proveniência.

A regra vigente é:

1. **HTML/JSON oficial com corpo completo e fiel**:
   - usar o texto oficial como conteúdo canônico;
   - **não chamar** o endpoint de download do PDF autenticado redundante;
   - preservar URL oficial, `externalId`, `authCode` e demais referências de autenticidade disponíveis;
   - registrar `authenticatedPdf = NOT_REQUESTED_REDUNDANT` e `contentRepresentation = OFFICIAL_HTML`;
   - anexos próprios continuam sendo baixados como `MATERIAL_CONTENT`.

2. **Página sem corpo oficial utilizável**:
   - o PDF autenticado deixa de ser redundante e passa a ser conteúdo material obrigatório;
   - o conector tenta o PDF oficial;
   - o arquivo é classificado `MATERIAL_CONTENT`, participa do hash legado/material e a publicação não é concluída se o PDF necessário falhar;
   - se não houver nem corpo oficial nem referência de PDF, o item permanece falho/incompleto.

3. **Página com corpo principal + anexos próprios**:
   - o PDF autenticado do corpo principal continua redundante e não é solicitado;
   - os attachments são necessários;
   - `officialContentCompleteness = PARTIAL_OFFICIAL_CONTENT` descreve que a página isolada não contém os anexos; a captura só fica operacionalmente completa após baixar esses anexos.

### Impacto sobre compatibilidade legada

Enquanto o acervo atual permanecer preservado, a compatibilidade v1→v2 continua necessária porque versões já persistidas incluem hashes de PDFs autenticados redundantes.

Uma reconstrução integral do domínio DOE-SP sob a nova política pode eliminar essa necessidade **somente para o acervo reconstruído**, desde que o preflight comprove que todas as versões v1 alvo foram retiradas e não existam dependências que exijam preservar os IDs/versões antigos.

Isso não deve ser generalizado:
- outros conectores podem ter PDF como conteúdo material;
- DOE-SP pode precisar do PDF material quando o corpo HTML estiver ausente;
- qualquer arquivo material continua exigindo proveniência e versionamento corretos.

A avaliação e o plano de reconstrução estão em `docs/doe-sp-rebuild-assessment.md`.
