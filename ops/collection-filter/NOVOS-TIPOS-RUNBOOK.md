# Runbook — aplicação em lote de novos tipos do filtro de coleta

Planilha: `ops/collection-filter/novos-tipos-2026-11.csv` (616 linhas: 21 `KEEP_ALWAYS`, 19 `KEEP_IF_TAX_TERM`, 576 `EXCLUDE_UNLESS_STRONG`).
Ferramenta: `ops/collection-filter/apply-new-types.ts`. Usa somente as rotas administrativas já existentes do filtro de coleta
(`new-types`, `direct-rule/preview|save|confirm`). **Não toca taxonomia**, não cria migrations e **não usa "Reaplicar filtro ao acervo"**.

## Regras de segurança

- **Nunca cole token, senha ou cookie no chat**, em issue ou em PR. A ferramenta nunca imprime nem grava token/senha; o token fica só na memória do processo.
- Credenciais: variáveis de ambiente `ADMIN_EMAIL` e `ADMIN_PASSWORD`, ou deixe vazias e a ferramenta pergunta (a senha é digitada sem eco).
  Dica: `read -s ADMIN_PASSWORD; export ADMIN_PASSWORD` evita deixar a senha no histórico do shell. Use uma conta de administrador de plataforma.
- `--base-url` precisa ser `https://...` (http só para localhost, usado em testes).
- Não use "Reaplicar filtro ao acervo" em nenhum momento deste procedimento.
- As fases 1 e 2 alteram produção. Rode `plan` e `phase1 --dry-run` primeiro e só avance com autorização.

## Preparação (na sua máquina)

```bash
git fetch origin && git checkout claude/f3-new-types-batch
npm ci
export BASE=https://<url-do-backend-em-producao>
export CSV=ops/collection-filter/novos-tipos-2026-11.csv
export OUT=./saida-novos-tipos          # relatórios e arquivos de estado (não versionar)
export ADMIN_EMAIL=<seu e-mail>         # a senha será pedida de forma oculta
```

## 1. plan (somente leitura)

```bash
npx tsx ops/collection-filter/apply-new-types.ts plan --base-url "$BASE" --csv "$CSV" --out "$OUT"
```

Aguarda o inventário ficar `READY` (cache assíncrono; "aquecendo" nunca é tratado como "sem tipos") e casa cada linha por
(fonte, seção, nome normalizado com a mesma normalização do servidor). Gera `plan.json`, `divergences.csv` e `divergences.md`:

- linhas da planilha sem item vivo; itens vivos abertos que não estão na planilha;
- diferenças de contagem de ocorrências (informativo: o acervo muda entre a planilha e hoje);
- chaves duplicadas; linhas/modos inválidos.

Sai com código diferente de zero se houver linha sem item vivo, inválida ou duplicada em conflito. **Revise `divergences.md`.**
Só use `--allow-divergences` depois de entender cada divergência (as linhas divergentes são simplesmente ignoradas nas fases seguintes).

## 2. fase 1 — regras KEEP (não destrutiva)

```bash
npx tsx ops/collection-filter/apply-new-types.ts phase1 --base-url "$BASE" --csv "$CSV" --out "$OUT" --dry-run
npx tsx ops/collection-filter/apply-new-types.ts phase1 --base-url "$BASE" --csv "$CSV" --out "$OUT"
```

Só `KEEP_ALWAYS` e `KEEP_IF_TAX_TERM`. Para cada tipo, em sequência: preview novo e depois save (cada save sobe a revisão da política, por isso
o preview é sempre refeito). **Nunca chama `confirm` e nunca apaga publicações.** O `count` do preview é só informativo
(`KEEP_IF_TAX_TERM` pode mostrar contagem > 0 por descartar o que não tem termo tributário, mas a fase 1 não apaga nada).
`--dry-run` faz só os previews. Para no primeiro erro HTTP. Estado em `$OUT/phase1.state.json`; relatório em `$OUT/phase1-report.csv`.

## 3. fase 2 — preview (somente leitura)

```bash
npx tsx ops/collection-filter/apply-new-types.ts phase2-preview --base-url "$BASE" --csv "$CSV" --out "$OUT"
```

Para cada tipo `EXCLUDE_UNLESS_STRONG`: quantas publicações do acervo seriam apagadas (`count`), `blockedCompany`, `blockedOtherSource` e até 3 títulos de exemplo.
Grava `phase2-preview.json/.csv/.md` e **não escreve nada no servidor**. Ao final imprime o **CÓDIGO DE APROVAÇÃO** (12 primeiros hex do sha256 de
`phase2-preview.json`) e `PARE: aprovação do Fábio necessária`.

- `blockedCompany`: publicações que seriam apagadas pela regra mas estão vinculadas a empresa de algum cliente. **Protegidas: são mantidas.**
- `blockedOtherSource`: publicações que também têm origem em outra fonte. **Protegidas: são mantidas.**

Envie `phase2-preview.md` (ou `.csv`) **e o código de aprovação** para aprovação. Não envie token/senha. Se qualquer coisa mudar, refaça o preview: o código muda com o arquivo.

## 4. fase 2 — confirmação (destrutiva; só após aprovação)

```bash
npx tsx ops/collection-filter/apply-new-types.ts phase2-confirm --base-url "$BASE" --csv "$CSV" --out "$OUT" \
  --approved "$OUT/phase2-preview.json" --approval-code <codigo-aprovado>
```

- Recusa se o sha256 do arquivo não bater com o código, se o CSV for diferente do usado no preview ou se houver item fora de `EXCLUDE_UNLESS_STRONG`.
- Para cada tipo aprovado: preview novo; se a contagem atual for **maior** que a aprovada, o tipo é **pulado e reportado** (nunca apaga mais que o aprovado,
  contando o acumulado de todas as execuções); senão `confirm` em passos (no máximo 500 por chamada; `resume:true` a partir do 2º) até `restantes = 0`.
  Tipos com contagem aprovada 0 só têm a regra persistida (save, não destrutivo).
- Progresso zero ou `changed:true` encerra aquele tipo sem tentar de novo; erro HTTP interrompe toda a execução. Tipos fora do arquivo aprovado nunca são tocados.
- Estado em `$OUT/phase2.state.json` (apagadas por tipo).

## Retomada

Basta repetir o mesmo comando com o mesmo `--out`: a fase 1 pula o que já foi salvo; a fase 2 pula tipos concluídos e retoma os demais, preservando o
teto aprovado. Não apague os arquivos de estado no meio do processo. Um 401 no meio da execução faz um novo login automático (uma vez por chamada).
Tipos cuja regra já foi salva deixam de aparecer na fila aberta do servidor; por isso o `plan` os mostra como "sem item vivo" depois de aplicados.

## Se algo der errado

Pare, não repita comandos às cegas e registre na Issue o trecho do log (sem credenciais) e o conteúdo de `phase1.state.json`/`phase2.state.json`.
