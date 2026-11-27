# Guia 1 — Gravar as regras dos 616 Novos tipos (Windows, PowerShell)

**O que esta rotina faz:** grava, no Filtro de Coleta, a regra de cada um dos 616 tipos da planilha `novos-tipos-2026-11.csv`:
- 19 com o modo **Manter sempre**;
- 50 com o modo **Manter só se tiver termo tributário**;
- 547 com o modo **Excluir, salvo termo forte**.

As mudanças em relação à planilha recebida estão em `novos-tipos-2026-11-ajustes.md`.

**O que ela NÃO faz:** **não apaga nenhuma publicação.** Ela só usa a função de *salvar regra* (`/save`), que vale para as **coletas futuras**. Para limpar o acervo já guardado, use o **Guia 2** (`NOVOS-TIPOS-LIMPEZA-PELA-TELA.md`), que é uma decisão à parte e feita pela tela.

> ⚠️ **Nunca cole senha, token ou cookie no chat, em issue ou em PR.** A senha é digitada sem aparecer na tela e não fica gravada em arquivo.

## 1. Instalação (uma vez só)

1. Instale o **Git for Windows**: <https://git-scm.com/download/win>. Aceite as opções padrão.
2. Instale o **Node.js 24**: <https://nodejs.org/>. Escolha a versão **24.x** e aceite as opções padrão.
3. Abra o **PowerShell**: menu Iniciar → digite "PowerShell" → Enter.
4. Confira as versões:
   ```powershell
   git --version
   node --version
   ```
   O `node --version` deve mostrar `v24.` alguma coisa.
5. Baixe o projeto e instale as dependências:
   ```powershell
   cd $HOME
   git clone https://github.com/fabiojuniort-cyber/radar-fiscal-backend.git
   cd radar-fiscal-backend
   git checkout claude/f3-new-types-batch
   npm ci
   ```
   O `npm ci` leva alguns minutos.

## 2. Preparar a janela

Repita isto **toda vez** que abrir um PowerShell novo para rodar a rotina:

```powershell
cd $HOME\radar-fiscal-backend
$BASE = "https://radar-fiscal-backend-production.up.railway.app"
$CSV  = "ops/collection-filter/novos-tipos-2026-11.csv"
$OUT  = "$HOME\saida-novos-tipos"
$env:ADMIN_EMAIL = "seu-email-de-administrador@exemplo.com"
$senha = Read-Host "Senha do administrador" -AsSecureString
$env:ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($senha))
```

- **URL do backend:** é o endereço público do backend do TriFaros (acima). Se ele mudar, pegue o novo no painel do Railway: serviço **radar-fiscal-backend** → **Settings** → **Networking** → domínio público.
- A senha é digitada **sem aparecer na tela** e fica só nesta janela do PowerShell.

## 3. Conferir antes, sem gravar nada (`--dry-run`)

```powershell
npx tsx ops/collection-filter/apply-new-types.ts plan   --base-url $BASE --csv $CSV --out $OUT
npx tsx ops/collection-filter/apply-new-types.ts phase1 --base-url $BASE --csv $CSV --out $OUT --dry-run
```

**`plan`** compara a planilha com a lista atual de Novos tipos e grava o resultado em `$OUT\divergences.md`. Abra esse arquivo:
```powershell
notepad "$OUT\divergences.md"
```
- **CSV_WITHOUT_LIVE_ITEM:** o tipo da planilha não está mais na lista de Novos tipos. Por exemplo, já foi classificado ou o nome mudou.
- **LIVE_NOT_IN_CSV:** um tipo novo apareceu depois da planilha.
- **COUNT_DIFFERENCE:** é só informativa, porque o acervo muda todo dia.

Se o `plan` terminar com erro por causa de divergências e você estiver de acordo com elas, acrescente `--allow-divergences` aos comandos seguintes. As linhas divergentes são ignoradas.

**`phase1 --dry-run`** só consulta, **não grava nada**. Exemplo de saída (os nomes e números aqui são ilustrativos):
```
inventário READY: 616 tipos abertos
[dry-run] doe-sp/Aviso KEEP_IF_TAX_TERM preview count=0 (informativo; nada é apagado) 812ms
[dry-run] dou/Extratos de Contratos EXCLUDE_UNLESS_STRONG preview count=44 (informativo; nada é apagado) 1530ms
...
phase1 resumo: salvos=0 ja_salvos=0 sem_item_vivo=0 erro=nao dry_run=true
nenhuma publicação foi apagada (rotina só usa /save)
```
O `count` mostra quantas publicações **já guardadas** aquele modo descartaria numa **limpeza futura**. **Esta rotina não apaga essas publicações.**

## 4. Gravar as regras (comando real)

```powershell
npx tsx ops/collection-filter/apply-new-types.ts phase1 --base-url $BASE --csv $CSV --out $OUT
```

Exemplo de saída (os nomes e números aqui são ilustrativos):
```
inventário READY: 616 tipos abertos
[saved] doe-sp/Aviso KEEP_IF_TAX_TERM rev=1201 preview=0 840ms
[saved] dou/Extratos de Contratos EXCLUDE_UNLESS_STRONG rev=1202 preview=44 1611ms
...
phase1 resumo: salvos=616 ja_salvos=0 sem_item_vivo=0 erro=nao dry_run=false
nenhuma publicação foi apagada (rotina só usa /save)
```

- São 616 tipos, um de cada vez. Pode levar de **minutos a cerca de uma hora**.
- Se cair a conexão ou você fechar a janela, **rode o mesmo comando de novo, com o mesmo `$OUT`**. Os tipos já salvos são pulados (`[skip] ... já salvo`).
- Não apague a pasta `$OUT` enquanto não terminar.
- Se aparecer erro (`erro=sim`), a rotina para no primeiro tipo com problema. Copie as últimas linhas, **sem a senha**, para a COORD.
- O relatório por tipo fica em `$OUT\phase1-report.csv`, que abre no Excel.

## 5. Conferir na tela que as regras entraram

1. Entre no site do TriFaros com a sua conta de administrador e abra **Administração → Filtro de Coleta** (`/admin/filtro-coleta`).
2. No topo, **"Política publicada: vX · revisão N"**: a revisão deve ter aumentado cerca de 616 em relação a antes.
3. A aba **"Novos tipos (N)"** deve mostrar bem menos itens. Os tipos gravados saem da fila.
4. Na aba **Tipos**, filtre a coluna **Nome do ato** por alguns tipos da planilha (por exemplo "Extratos de Contratos", "Comunicado", "Renovação de Inscrição Estadual") e confira a coluna **Modo**:
   - "Excluir, salvo termo forte";
   - "Manter só se tiver termo tributário";
   - "Manter sempre".
5. A aba **Desconsiderados** passa a registrar, nas próximas coletas, o que for descartado por essas regras.

## 6. Ao terminar

Feche o PowerShell. A senha some junto. Se quiser limpar antes:
```powershell
Remove-Item Env:ADMIN_PASSWORD
```

## Observações técnicas

- A rotina só chama `GET /new-types`, `POST /direct-rule/preview` e `POST /direct-rule/save`, um tipo por vez, sempre com uma prévia nova antes de salvar.
- O `/save` grava apenas a regra e nunca expurga o acervo: `saveDirectFilterRule` devolve `deletedCount: 0`, e a rota não chama `collection_filter_direct_purge_batch`.
- A rotina não toca a taxonomia e não usa "Reaplicar filtro ao acervo".
