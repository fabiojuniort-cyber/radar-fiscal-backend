# Conector Portal Nacional NF-e/ENCAT

## Escopo

O conector `nfe-encat` cobre exclusivamente quatro famílias do Portal Nacional da NF-e:

- Notas Técnicas;
- Informes Técnicos;
- Esquemas XML da NF-e/NFC-e;
- Manuais da NF-e/NFC-e.

Outros DF-e encontrados nas mesmas páginas, incluindo NFGas, NFAg, NFCom, NF3e e NF-e ABI, são descartados pelo parser.

## Listagens oficiais

- Notas Técnicas: `https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=`
- Informes Técnicos: `https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=hXzemuyNHW4=`
- Esquemas XML: `https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w=`
- Manuais: `https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=ndIjl+iEFdE=`

As quatro listagens completas são consultadas em toda execução. O conector não assume que o item mais novo esteja no topo e não usa cursor por posição.

## Sessão HTTP e redirects

O `NfeEncatClient` usa cookie jar em memória por tentativa. Redirects são manuais, limitados e restritos ao mesmo origin `https://www.nfe.fazenda.gov.br`. Isso cobre o fluxo `AspxAutoDetectCookieSupport=1` e preserva também `ASP.NET_SessionId`.

Redirect loop, redirect cross-origin, captcha/`consultaRecaptcha.aspx`, página de erro, Content-Type inválido e HTML devolvido no lugar de PDF/ZIP/XML são falhas de consulta, nunca resultado vazio. Notas, Informes e Schemas usam seções `p.tituloSessao`; a página oficial de Manuais usa `label.tituloPrincipal` e é validada separadamente.

Os códigos 408, 425, 429 e 5xx são tratados como falhas transitórias/retryable. O executor do Motor continua responsável pelo timeout global da tentativa; o cliente adiciona timeout por requisição e respeita o `AbortSignal` recebido.

## Identidade e versionamento

O token `conteudo` do link `exibirArquivo.aspx` é preservado como `externalId` e origem oficial.

Para Notas e Informes Técnicos, número e versão oficial compõem `actNumber`. Exemplo:

- `metadata.documentFamily = "NT 2025.002"`;
- `metadata.officialVersion = "1.50"`;
- `actNumber = "2025.002 v1.50"`.

Assim, v1.40 e v1.50 são publicações distintas. Uma alteração posterior nos bytes do arquivo da própria v1.50 mantém a identidade e altera o `content_hash`, produzindo uma nova `publication_version` pelo Motor existente.

## Arquivos e SHA-256

Cada item só é emitido ao Motor quando existe um checkpoint de arquivo válido. O download preserva nome (`Content-Disposition`), MIME, tamanho, ETag/Last-Modified e SHA-256 dos bytes. O `rawSha256` é colocado em `files[]`; o normalizador existente já incorpora os hashes dos arquivos ao `contentHash`.

O estado incremental sempre relê as quatro listagens completas. Para itens já conhecidos, um checkpoint de arquivo validado nas últimas 24 horas é reaproveitado sem novo download; isso não oculta novas versões/tokens inseridos em qualquer posição da listagem. Itens conhecidos vencidos são revalidados em lotes oldest-first de até 16 arquivos por execução, distribuindo a revisão periódica ao longo das execuções horárias. Quando há ETag/Last-Modified, a revalidação usa requisições condicionais e um `304 Not Modified` reaproveita o SHA-256; quando não há validador, o arquivo selecionado para rechecagem é baixado novamente e rehasheado. Itens novos são sempre baixados imediatamente.

## Estado e falhas parciais

`nfe-encat-source-state.repository.ts` recupera o checkpoint apenas do último **run terminalmente bem-sucedido** (`SUCCESS`/`SUCCESS_NO_RESULTS`); um `PARTIAL_SUCCESS` nunca avança o estado incremental. Desde o Hardening do Motor o estado fica em `collection_checkpoints` (ver `docs/hardening-motor.md`); `collection_attempts.metadata.nfeEncatState` só é lido como fallback de transição.

Falha de download/processamento de um documento gera `partialFailures` e não impede os demais itens de serem coletados. Se todas as quatro listagens falharem, o conector lança `NFE_ENCAT_ALL_LISTINGS_FAILED`, permitindo ao Motor registrar fonte indisponível/falha de fetch em vez de `SUCCESS_NO_RESULTS`.

Quatro listagens consultadas com sucesso, com a estrutura oficial reconhecida, e zero itens válidos constituem resultado vazio legítimo. A telemetria do conector também informa quantos checkpoints foram reaproveitados, quantos itens conhecidos foram rechecados, quantos arquivos foram baixados e quantos retornaram `304`.

## Ativação

O conector é registrado no `connector-registry.factory.ts`, porém esta entrega não cria/ativa uma linha de fonte no banco, não executa migration produtiva e não faz deploy no Railway. A ativação operacional deve ocorrer em etapa separada após merge e validação.
