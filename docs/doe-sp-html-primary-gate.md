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
- `AUTHENTICATED_PUBLICATION_PDF` => `PROVENANCE`.

O PDF autenticado permanece no metadata da origem, mas fica fora do metadata/hash da versão v2.

### Compatibilidade v1 sem reescrita histórica

Uma versão atual v1 pode ser reutilizada por um replay v2 somente quando todos os critérios são demonstrados:
1. mesmo `publication_id` obtido pela identidade normal do sistema;
2. título canônico exatamente igual;
3. texto canônico exatamente igual;
4. vigência igual, inclusive ausência;
5. hashes dos anexos `ATTACHMENT` legados exatamente iguais aos arquivos materiais recebidos;
6. todos os arquivos legados não-PDF autenticado possuem classificação conhecida e hash válido.

Se qualquer arquivo legado tiver classificação desconhecida, hash ausente, título/texto/vigência divergente ou anexos diferentes, a compatibilidade não é presumida e o fluxo normal de versionamento permanece explícito.

A equivalência nunca altera `content_hash`, `source_metadata` ou arquivos da versão histórica. Ela apenas evita uma versão artificial no replay.

### Proveniência por origem

O normalizador passa a distinguir:
- `metadata`: material da versão;
- `originMetadata`: evidência completa observada naquela origem.

Assim, um PDF autenticado disponível fica somente na origem que efetivamente o forneceu. Uma origem com PDF 404 mantém URL, authCode e diagnóstico da falha, sem receber arquivo de outra origem.
