# Runbook — aplicação em lote de novos tipos do filtro de coleta

Planilha: `ops/collection-filter/novos-tipos-2026-11.csv` (616 linhas: 19 `KEEP_ALWAYS`, 50 `KEEP_IF_TAX_TERM`, 547 `EXCLUDE_UNLESS_STRONG`, após o ajuste de 2026-11-27 — ver `novos-tipos-2026-11-ajustes.md`).
Ferramenta: `ops/collection-filter/apply-new-types.ts`. Usa somente as rotas administrativas já existentes do filtro de coleta
(`new-types`, `direct-rule/preview|save`). **Não toca taxonomia**, não cria migrations e **não usa "Reaplicar filtro ao acervo"**.

## Regras de segurança

- **Nunca cole token, senha ou cookie no chat**, em issue ou em PR. A ferramenta nunca imprime nem grava token/senha; o token fica só na memória do processo.
- Credenciais: variáveis de ambiente `ADMIN_EMAIL` e `ADMIN_PASSWORD`, ou deixe vazias e a ferramenta pergunta (a senha é digitada sem eco).
  Dica: `read -s ADMIN_PASSWORD; export ADMIN_PASSWORD` evita deixar a senha no histórico do shell. Use uma conta de administrador de plataforma.
- `--base-url` precisa ser `https://...` (http só para localhost, usado em testes).
- Não use "Reaplicar filtro ao acervo" em nenhum momento deste procedimento.
- A fase 1 grava regras em produção (não apaga publicações). Rode `plan` e `phase1 --dry-run` primeiro e só avance com autorização.

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
Só use `--allow-divergences` depois de entender cada divergência (as linhas divergentes são simplesmente ignoradas na fase 1).

## 2. fase 1 — salvar as regras de todas as linhas (não destrutiva)

```bash
npx tsx ops/collection-filter/apply-new-types.ts phase1 --base-url "$BASE" --csv "$CSV" --out "$OUT" --dry-run
npx tsx ops/collection-filter/apply-new-types.ts phase1 --base-url "$BASE" --csv "$CSV" --out "$OUT"
```

Todas as linhas, nos três modos. Para cada tipo, em sequência: preview novo e depois save (cada save sobe a revisão da política, por isso
o preview é sempre refeito). **Nunca apaga publicações.** O `count` do preview é só informativo
(`KEEP_IF_TAX_TERM` pode mostrar contagem > 0 por descartar o que não tem termo tributário, mas a fase 1 não apaga nada).
`--dry-run` faz só os previews. Para no primeiro erro HTTP. Estado em `$OUT/phase1.state.json`; relatório em `$OUT/phase1-report.csv`.

## Retomada

Basta repetir o mesmo comando com o mesmo `--out`: a fase 1 pula o que já foi salvo. Não apague os arquivos de estado no meio do processo. Um 401 no meio da execução faz um novo login automático (uma vez por chamada).
Tipos cuja regra já foi salva deixam de aparecer na fila aberta do servidor; por isso o `plan` os mostra como "sem item vivo" depois de aplicados.

## Se algo der errado

Pare, não repita comandos às cegas e registre na Issue o trecho do log (sem credenciais) e o conteúdo de `phase1.state.json`.
