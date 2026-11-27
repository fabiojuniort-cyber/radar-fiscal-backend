# Guia 2 — Como apagar pela tela o acervo já guardado (Filtro de Coleta)

Este guia é **separado** da rotina de regras (Guia 1). As duas coisas são diferentes:

| | Guia 1: rotina `apply-new-types` | Guia 2: tela do Filtro de Coleta |
|---|---|---|
| O que faz | Grava a regra de cada um dos 616 tipos | Apaga publicações **já guardadas** que a regra descarta |
| Apaga alguma coisa? | **Não. Nunca.** Só usa `/save`. | **Sim.** A exclusão é física, em lotes de até 500. |
| Efeito | Vale para as coletas **futuras** | Vale para o **acervo existente** |
| Quando usar | Primeiro | Depois, se e quando você decidir limpar o acervo |

Em todos os casos, publicações **vinculadas a empresa cliente** ou **com outra origem oficial** ficam **protegidas**: não são apagadas, e a tela informa quantas são.

## Antes de começar

1. Entre no site do TriFaros com a sua conta de administrador.
2. Abra **Administração → Filtro de Coleta** (endereço `/admin/filtro-coleta`).
3. Confira no topo **"Política publicada: vX · revisão N"**. Depois do Guia 1, a revisão estará maior e os tipos aparecerão na aba **Tipos**.

## Opção A — Por tipo (recomendado: controle fino)

Apaga **só** as publicações já guardadas de **um** Nome do ato.

1. Abra a aba **Tipos**.
2. Na tabela **Nomes de ato**, use o filtro da coluna **Nome do ato** para achar o tipo, por exemplo "Extratos de Contratos". Confira a **Fonte** e a **Seção**.
3. O tipo já estará com o modo **"Excluir, salvo termo forte"**, porque o Guia 1 gravou a regra. Como a tela só abre a prévia quando o modo **muda**, faça assim:
   1. Mude o **Modo** para **"Manter sempre"**. Isso salva na hora e **não apaga nada**.
   2. Mude o **Modo** de volta para **"Excluir, salvo termo forte"**. Abre a janela **"Classificar Nome do ato"**.
4. Clique em **"Consultar prévia F3"**. A janela mostra:
   - **"N publicações serão apagadas ao salvar"**;
   - quantas estão **protegidas** (empresa cliente ou outra origem oficial);
   - **amostras** de títulos.
5. Leia as amostras. Se houver algo tributário, clique em **Cancelar** e nada é apagado.
6. Se estiver tudo certo, clique em **"Salvar e excluir N publicações"**. A exclusão anda em **lotes de até 500**. Para interromper, clique em **"Parar após o lote atual"**: o lote em andamento termina e o resto fica para depois.
7. Se aparecer **"A prévia mudou. Consulte e confirme novamente."**, chegaram publicações novas. Consulte a prévia de novo e confira a nova contagem antes de confirmar.

> Entre os passos 3.1 e 3.2, por alguns segundos, a regra fica "Manter sempre". Isso só afeta uma coleta que rodar exatamente nesse intervalo e não apaga nada.

## Opção B — Em lote: "Reaplicar filtro ao acervo" (mais amplo)

O botão **"Reaplicar filtro ao acervo"**, no topo da página, aplica **todas as regras da política** ao acervo de uma vez. Por isso é **mais amplo** do que os 547 tipos de exclusão. Ele também inclui:
- **todas as regras de exclusão que já existiam** antes desta rotina, não só as novas;
- **os tipos "Manter só se tiver termo tributário"**, tanto os 50 desta planilha quanto os que já existiam: as publicações deles **sem** termo tributário também entram na limpeza. Na Opção A, nada desses tipos é apagado.

Use só se a prévia mostrar exatamente o que você quer apagar:

1. Clique em **"Reaplicar filtro ao acervo"** e depois em **"Consultar quantidade"**.
2. Leia o resultado:
   - **"N não passam no filtro atual / M protegidas"**;
   - a lista **"Quantidades por Nome do ato"**;
   - as **amostras**.
3. Se aparecer algum Nome do ato que você **não** quer apagar, clique em **Cancelar** e use a **Opção A**, tipo por tipo.
4. Se estiver tudo certo, clique em **"Confirmar exclusão"**. A exclusão anda em lotes de até 500. Use **"Pausar"** e **"Continuar"** para controlar o ritmo.

## Recomendação

- Comece pela **Opção A** nos tipos de maior volume (por exemplo "Extratos de Contratos", "Extratos de Termos Aditivos", "Comunicado", se for o caso) e confira as amostras de cada um.
- Use a **Opção B** só se a lista "Quantidades por Nome do ato" estiver toda de acordo com o que você quer apagar.
- Nunca compartilhe senha ou token no chat.
