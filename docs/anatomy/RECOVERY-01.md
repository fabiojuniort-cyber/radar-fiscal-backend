# ANAT-04 — RECOVERY-01: busca dos 18 originais e proposta de recaptura

Origem: COORD → EXEC, ANAT-04, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244, branch `feat/anat-04-core`. Busca feita em 17/10/2026 sobre o SHA de referência `b638a27544af75b5a90c1f6b17f7cb75803ce127`.

**Resultado: 0/18 localizados.** O histórico Git dos dois repositórios foi varrido por completo; a varredura do disco local ficou incompleta. Não houve nenhuma requisição às fontes DOE-SP ou RFB.

## Método

- **Critério de identificação:** SHA-256 dos bytes **brutos** de cada arquivo, comparado com os 18 hashes do §7.3 do desenho (`documentedExpectedSha256` no manifesto). Nenhum arquivo foi normalizado, decodificado ou regravado. O conteúdo das entradas não foi interpretado.
- **Locais pesquisados:**
  1. Histórico Git completo de `radar-fiscal-backend`: espelho com todos os branches, tags e refs `refs/pull/*`; 3.640 blobs entre 100 B e 30 MB. **0 correspondências.**
  2. Histórico Git completo de `tribusca-control`: espelho com 51 refs; 914 blobs. **0 correspondências.**
  3. Disco local do usuário: `Downloads`, `Documents`, `Desktop`, `AppData/Local/Temp` (inclui temporários de sessões) e `OneDrive`, arquivos de 100 B a 30 MB, sem `node_modules` e `.git`. **Busca por hash concluída em 17/10/2026, sem correspondência.** Varredura (PowerShell `Get-FileHash`) de arquivos `.json/.txt/.html/.htm` de 100 B a 30 MB, sem `node_modules`/`.git` e sem baixar arquivos só na nuvem: `Downloads` + `Desktop` com 35.534 arquivos; `Documents` + `AppData/Local/Temp` + `OneDrive` com 200 arquivos. **Limitações:** foram examinadas só essas extensões (um JSON salvo com outra extensão ou sem extensão não seria visto); arquivos só na nuvem não foram examinados; e a contagem baixa nas três últimas pastas sugere que a enumeração pode ter sido parcial (permissões ou erros silenciosos). **Varredura completa posterior (Node, todas as extensões):** 14.119.050 arquivos de 100 B a 30 MB em `Downloads`, `Documents`, `Desktop`, `AppData/Local/Temp` e `OneDrive`, sem `node_modules`/`.git`, com hash dos bytes brutos: **0 correspondências**. Isso cobre a limitação de extensão da varredura anterior. Continuam fora: arquivos maiores que 30 MB ou menores que 100 B, outras pastas, outras máquinas e o chat/armazenamento da sessão que elaborou o desenho. Conclusão: os 18 originais não estão nos locais varridos desta máquina.
  4. Transcrições de sessões do Claude Code, inclusive arquivadas, buscando `corpus-inventory` e `ANAT-03`: **nenhuma sessão**. O desenho não foi elaborado neste app.
  5. Desenho local `Downloads/anat-desenho.md`, de 15/10/2026: confirma a leitura direta das APIs em 15/10/2026 (§7.2). O §7.3 registra **somente hashes**; não há corpos, nem caminhos de arquivos salvos.
- **Não pesquisados por falta de acesso nesta sessão:**
  - anexos e arquivos do chat GPT que elaborou o desenho;
  - artefatos de GitHub Actions e assets de releases (o conector GitHub devolve 404 para este repositório).

  Se algum desses locais guardou os JSONs, basta copiar os arquivos para o diretório de entrada. A conferência por hash está descrita abaixo.

## Inventário por ID

Em todas as linhas: **ausente**, sem localização e sem proveniência, tamanho desconhecido, SHA-256 encontrado nulo. Por isso não há comparação de igualdade possível. As linhas marcadas como reserva tiveram apenas o hash comparado.

| ID | Partição | Fonte | sourceId | SHA-256 esperado (§7.3) |
|---|---|---|---|---|
| 13 | desenvolvimento | DOE-SP | `b768399b-6638-460d-bce0-08df049590c6` | `6a695d3e2ab156572c9c852175255905a5c891a5f05561da3f1b648250083d1f` |
| 14 | **reserva** | DOE-SP | `1445d0d3-e469-4d7f-ed0b-08df081b20d4` | `f56381e7076e0e4f26f70e4a4dc0b1c657871c6218037e2d9f4b50e728cd1527` |
| 15 | desenvolvimento | DOE-SP | `a2e9bf6e-6d2f-430e-23cc-08df09ae1af9` | `b2e012ede2228d65c41b9e387410a1c1d0a69f28477e0fe635c4e5d541a85d8a` |
| 16 | **reserva** | DOE-SP | `b8fb1bba-1e31-407d-ab7f-08df0495b84e` | `19585b9ab7edbbcf527c0fc4966c54a86fcf677351d23dbdce96bddd3fe9bfb8` |
| 17 | desenvolvimento | DOE-SP | `9716c5c2-7f22-46eb-a80d-08df0495b6f6` | `043449c800d2c72e6f7f9ae472c943784d3340786179bf8724cb3bf089c875b1` |
| 18 | **reserva** | DOE-SP | `91174000-076a-4029-bc7f-08df049590c6` | `05d941844a919981864ea7e57d271fa95feaa401953c35344503c6c89de856a6` |
| 19 | desenvolvimento | DOE-SP | `ffe36bfd-ee7d-487b-d449-08df09ac2b13` | `f95802e72f55bf77f7e8357d8858ec02e8ef7453f3f643403495c096d6166866` |
| 20 | desenvolvimento | DOE-SP | `70413500-3dd4-4b9b-a88a-08df0495b6f6` | `c9de38fdb4b5d254bcb755d4205c448a984c8169013671f9c55009c69bf48469` |
| 21 | desenvolvimento | DOE-SP | `d7eb71ec-9daf-4804-7eae-08df0817934e` | `1cc461fc6b77eaa6546cb150d5d1ac0baaf1c3e257acc50fcda7bbdee1d85c62` |
| 22 | desenvolvimento | DOE-SP | `a1f3e33f-e962-4ae9-ed58-08df04981eb4` | `79c4267ed711f30da6e54e4c9a46132996ba65ece3988d9343de7c9d2e41eb27` |
| 23 | desenvolvimento | RFB | `153836` | `84d788bb314510166cb70aade948f49c1606915056bf452c1619c15727a135ac` |
| 24 | **reserva** | RFB | `153828` | `5397923095b1eb29669eb68a2a22aac5f9a066cc9f73ef582030d3b010f31a03` |
| 25 | desenvolvimento | RFB | `153829` | `b9c737dc353c52c9ae5e32f5180e86f45c2f8d419e5de64cee165ad0a4b240bd` |
| 26 | desenvolvimento | RFB | `153819` | `e9c21d1e289cdffe1a37a9db5c62f82e96512c012dd403721f134dd92b132b56` |
| 27 | desenvolvimento | RFB | `153820` | `254d91ef371696d0367d33ebe066eabcd1d3773d77ba232986a6c835f7f5b6f2` |
| 28 | **reserva** | RFB | `153821` | `7dbe7bce751bed280e1bf8cbf9e4857ce3050e679a39915b0e41bc49c61d3263` |
| 29 | desenvolvimento | RFB | `153822` | `0fd21cff718b2c15e0839257c913c8252f3c61c3193ae89669d9cc6aa43ad424` |
| 30 | desenvolvimento | RFB | `153743` | `2ac5537168fff4dcda5ce5bbae1861b38c890a5c42941c3442687530373100a3` |

Os hashes completos e as URLs oficiais estão no [manifesto](../../test/fixtures/anatomy/corpus-manifest.json). Ele **não foi alterado**.

## Proposta de recaptura

Esta proposta **depende de autorização específica do Fábio e não foi executada**.

1. **Fontes e endpoints:** os mesmos do desenho e do manifesto (`officialUrl`).
   - DOE-SP: `GET https://do-api-web-search.doe.sp.gov.br/v2/publications/{sourceId}`, IDs 13–22.
   - RFB: `GET https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/{idAto}/visao/original`, IDs 23–30.
2. **Quantidade de requisições:**
   - **18 GETs** de corpo, um por ID, sequenciais, com intervalo mínimo de 2 s, sem retry automático (no máximo uma nova tentativa manual por ID).
   - Anexos: **nenhuma requisição na primeira etapa**. Os anexos referenciados (por exemplo, o PDF do ID 21 e os `arquivoBinario` da RFB) são listados no manifesto de anexos como `missing`. A captura deles exige outra autorização, com contagem exata.
3. **Armazenamento durável dos bytes:**
   - Salvar a resposta HTTP **exatamente como recebida** (corpo bruto, sem pretty-print nem reencoding).
   - Guardar em armazenamento privado autorizado; atos de pessoal (IDs 19 e 22) têm dados pessoais e **não** podem ir para o repositório público.
   - No repositório entram somente: hash, tamanho, cabeçalhos relevantes (`content-type`, `etag`, `last-modified`, `date`), data/hora UTC da captura e, quando necessário, uma representação sanitizada com hash próprio e a transformação documentada.
4. **Registro por ID:** URL, data/hora, status HTTP, `content-type`, tamanho, SHA-256 bruto, representação (`OFFICIAL_JSON`), executor e autorização (link do comentário de autorização na issue #116).
5. **Comparação com os hashes anteriores:**
   - **Hash igual:** os bytes são idênticos à captura do desenho. O arquivo recupera o original (`availability: available`, `actualSha256` igual ao esperado).
   - **Hash diferente:** a resposta mudou. É uma **nova captura**, não o original. Registrar `availability: recaptured-divergent` com os dois hashes lado a lado. O hash esperado documentado nunca é sobrescrito.
6. **Versionamento do corpus:**
   - Se todos os 18 hashes baterem, o manifesto continua na mesma versão, completada.
   - Se algum divergir, o manifesto sobe de versão (`manifestVersion` +1), com nota de divergência por ID, e as fichas e o gold dessas entradas passam a referir a nova captura.
7. **Proteção da reserva:**
   - IDs 14, 16, 18, 24 e 28: recaptura e hash feitos de forma **mecânica** por um script, sem leitura, impressão ou execução do motor.
   - Os bytes reservados vão para um local separado, fora do acesso do executor que ajusta regras.
   - Anotação da reserva segue o protocolo próprio em [gold-protocol.md](gold-protocol.md#4-revisão-e-reserva).

## Estado

`BLOCK_CORPUS_INPUTS_AND_GOLD` continua: 12/30 publicações disponíveis, 18 ausentes, 0/30 com gold revisado. O PR continua draft. Não houve coleta, merge, deploy, acesso a produção nem leitura da reserva.
