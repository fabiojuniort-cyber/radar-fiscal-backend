# E9-P2c-PDF83325-G1: protocolo de execução única (C-5)

**Estado:** grant **suspenso**. Este protocolo **não autoriza** a requisição; o COORD decide depois do parecer independente.

## 1. Limite (o que o código garante e o que não garante)
- **Garante (no código, testado):**
  - débito persistido antes do envio;
  - um disparo;
  - redirect nunca seguido; URL final fixada;
  - identidade estrutural do PDF; limite de tamanho durante a leitura; escrita em dois tempos.
- **Garante (preflight, em todo caminho):** `runAttachment` aplica o preflight **também quando chamado direto**, não só pela CLI (R3; teste `R3 C-5`). O preflight exige que o ledger local seja **byte a byte igual ao publicado** em `origin/<branch>` e que não tenha tentativas.
- **NÃO garante:** exclusividade entre checkouts **antes** de qualquer push.
  - Duas cópias com o mesmo ledger publicado (ativado e ainda não consumido) passam ambas no preflight.
  - O lease (`budget-state.json.lock`) só coordena **um** arquivo, num **único** checkout.
  - Não existe trava distribuída, por decisão do COORD (sem novo componente).
  - O preflight é **mitigação**, não garantia. A exclusividade depende deste protocolo.

## 2. Papéis
- **Responsável único:** o dono do grant, `EXEC #303 (claude/anat-e9-coverage)`, numa única sessão nomeada.
- **COORD:** autoriza a ativação por escrito na tribusca-control#116, citando o SHA do checkout autorizado.
- **Testemunha:** o registro na #116, com antes e depois.

## 3. Sequência com pontos de parada (nenhum envio antes do passo 7)
1. **Autorização:** comentário do COORD na #116 com "ativar E9-P2c-PDF83325-G1", o SHA autorizado do #303 e a sessão responsável. **PARA** se faltar qualquer item.
2. **Checkout único:** `git rev-parse HEAD` = SHA autorizado; árvore limpa (`git status --porcelain` vazio). **PARA** se divergir.
3. **Anúncio de exclusividade:** comentário na #116: "início da execução única E9-P2c-PDF83325-G1, sessão X, SHA Y; nenhuma outra execução autorizada". Uma execução sem esse anúncio é inválida.
4. **Ativação publicada:** um commit muda só `grant.status` para `active`, com nota citando o passo 1, e é **publicado** (push). Conferir: `git show origin/claude/anat-e9-coverage:…/budget-state.json` igual ao local. **PARA** se o push falhar ou se o publicado divergir.
5. **Preflight:** `ledgerPreflight(local, publicado)` deve dar `null` (`used.total` = 0, sem tentativas). **PARA** se recusar (código 3).
6. **Ensaio seco:** `npx tsx --test test/anatomy.collect-p2c-attachment.unit.test.ts` verde no mesmo checkout. **PARA** se falhar.
7. **Execução única:**

   ```bash
   npx tsx ops/anatomy/collect-p2c-attachment.ts --grant E9-P2c-PDF83325-G1 --owner 'EXEC #303 (claude/anat-e9-coverage)' --stop-after 1
   ```

8. **Persistência imediata do consumo, com ou sem sucesso:**
   - suspender o grant (`status: suspended`);
   - commit do ledger (tentativa e resultado) e, se gravados, do PDF e do meta;
   - **push imediato**;
   - comentário na #116 com o resultado (`outcome`, SHA-256 e bytes, ou o motivo da recusa).
9. **Fechamento:** conferir que o ledger publicado mostra `used.total` = 1. Qualquer nova tentativa exige grant novo.

## 4. Como comprovar que não houve outra execução simultânea
- O ledger publicado só pode ter **1** tentativa, com `debitedAt` entre o anúncio (passo 3) e o fechamento (passo 9).
- O histórico do arquivo (`git log -p -- …/budget-state.json`) mostra exatamente: ativação → consumo → suspensão, sem commits concorrentes.
- Um push de consumo rejeitado (non-fast-forward) **é prova de concorrência**: parar, não forçar e reportar.

## 5. Fora deste protocolo
- Nenhuma descoberta e nenhum outro anexo.
- O PDF tachado 82416 nunca é pedido.
- O layout real do PDF 83325 não foi verificado. Uma recusa de identidade gasta a requisição e não grava nada (fail closed).
