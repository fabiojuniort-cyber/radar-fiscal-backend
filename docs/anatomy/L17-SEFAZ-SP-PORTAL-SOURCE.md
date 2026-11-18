# ANAT-L17 — fonte tipada `SEFAZ-SP-PORTAL` no motor

**Decisão:** L17 aprovada pelo Fábio só para implementação R2 isolada, **sem migration nem produção**; L18 adiada (tribusca-control#116, c.6649410567). Recheck do #291: c.6649544018.

**Dependência exata:** construído sobre o #291 @ `9e03d60c0c20bd973f6b75e2671f7e95c614f022` (L14–L16, aprovado técnico no recorte do leitor). Não depende do #289/#290. O #285 não é tocado.

## O que muda
- **Contrato do motor:** `input.source` aceita `SEFAZ-SP-PORTAL`, distinto de `DOE-SP`. `input.sefazSpPortal` leva a prova (o objeto emitido por `prepareSefazSpPortalPage`). Ela é passada **por referência**; JSON serializado ou cópia nunca passa.
- **Fail-closed:** com `SEFAZ-SP-PORTAL`, sem prova válida, `readAnatomyInput`/`analyzeAnatomy` lançam `SefazSpProvenanceError` (`sefaz_sp_portal_provenance_unverified`). Uma prova enviada com outra fonte é recusada (`TypeError`). O tipo da fonte declarado pelo chamador e a marca `data-sefaz-sp-portal` no HTML **nunca** autenticam a origem.
- **L15/L16 no motor completo:** com a prova, notas → `editorial_note` (prohibited) e `p.revogado` → `historical` (`sefaz_sp_portal_revogado`). `legalStatus` `unknown`; nenhuma elegibilidade positiva. `DOE-SP` deixou de reagir à prova: o Diário Oficial volta exatamente ao comportamento anterior ao #291.
- **Perfil de regras:** o portal usa **só o perfil padrão** (`FIXED_PROFILE_SOURCES`). Ajustes por fonte de `DOE-SP` não se aplicam a ele, e não há escopo administrável de fonte ou família para ele. A configuração pelo admin depende da fase de persistência.
- **Preparação `sefaz-sp-portal/0.2.0-provisional`:** o HTML preparado é idêntico ao da 0.1.0. Mudaram:
  - `readerSource: 'SEFAZ-SP-PORTAL'`;
  - `provenance: { level: 'local_preparation', collectedFromOfficialSourceVerified: false }`;
  - `preparationId` passa a incluir o `resourceId`.

## R1-SP-03
- **Identidade única:** `representationId` precisa ser igual a `preparation.resource.resourceId`. Os `sourcePointers[].resourceId` são esse mesmo id (o teste verifica todos os ponteiros). Um `representationId` divergente é recusado.
- **Metadados internos congelados** em profundidade: `region`, `rawSpan`, `htmlSpan`, `resource`, `provenance`. A verificação exige o objeto inteiro congelado, refaz o SHA da região e o `preparationId`.
- **Prova local × coleta oficial:** a prova liga bytes, URL, hash, região e recurso numa preparação **local**. Ela **não** verifica que os bytes vieram do portal oficial. Toda análise do portal recebe a limitação `sefaz_sp_portal_local_preparation_only` (status `partial`). A procedência da coleta continua no snapshot (`urlStatus:candidate`, `urlVerified:false`, `verified:false`, `promoted:false`).

## Dependência de banco (não implementada)
`migrations/077_anat_base.sql` restringe `publication_anatomies.source` a `CONFAZ`, `DOU`, `DOE-SP` e `RFB`. Hoje nenhum caminho de produção grava resultados do motor (o serviço admin marca análises como `unsupported`). Gravar análises `SEFAZ-SP-PORTAL`, ter perfis administráveis para ela (`PROFILE_SOURCES`, rotas de configuração) e cadastrar a fonte no coletor exigem **migration e escopo próprios**: fase futura, a submeter ao COORD.

## L18
Não implementada: `blockquote` continua citação `prohibited`, inclusive com prova (teste no caminho do motor).

## Antes × depois
| | `9e03d60c` | L17 |
|---|---|---|
| Identidade do motor | `adebe95c` | `7a7c5fab` |
| art. 7º pelo motor (não identificado / notas / históricos) | só pelo leitor | 103 / 12 / 1 |
| An. II art. 39 pelo motor | só pelo leitor | 68 / 3 / 14 |
| As mesmas páginas lidas como DOE-SP (bruto e preparado) | — | saída do leitor **idêntica** (`c18b3f1a`/`691a810a`; `ec2fdba3`/`e634e408`) |
| 5 INs RFB (SHA da saída do leitor) | `d0b30141`, `4da42f18`, `86fd6219`, `061fa137`, `5126448b` | **idênticos** |
| HTML preparado (SHA) | `9a3d17e0`, `40fe068c` | **idênticos** |

Snapshot sintético inalterado. O `outputHash` de qualquer análise muda porque inclui a identidade do motor.
