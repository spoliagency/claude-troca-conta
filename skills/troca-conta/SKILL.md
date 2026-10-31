---
name: troca-conta
description: Passo a passo guiado para configurar a troca automatica de conta do Claude Code (quando uma conta bate o limite de uso, troca para a outra e a sessao continua sozinha), com confirmacao de que funcionou. Use quando a pessoa pedir para configurar, instalar, cadastrar ou adicionar uma conta, testar a troca, ver qual conta esta ativa, trocar de conta na mao, ou disser que o limite acabou e quer alternar entre contas. Tambem para um PC novo ou para o Mac.
---

# Troca de conta do Claude Code: assistente guiado

Todos os comandos usam o mesmo script:

```
node "${CLAUDE_SKILL_DIR}/../../scripts/trocar-conta.js" <comando>
```

Se `${CLAUDE_SKILL_DIR}` aparecer sem ser trocado pelo caminho, ache o plugin com `claude plugin list --json`
(campo `installPath` de `troca-conta`) e use `<installPath>/scripts/trocar-conta.js`.

## Regras do assistente

1. **Nunca assuma em que passo a pessoa esta.** A cada passo rode `guia` e siga somente o que a linha `AGORA:` mandar.
   O estado vem do login e das contas guardadas de verdade, nao da conversa.
2. **Um passo por vez.** Ao terminar cada um, confirme com a prova, no formato:
   `✔ Passo 2 concluido: primeira conta guardada (a@x.com)` ou `✖ Passo 2 nao concluiu: <o que falta>`.
   So passe ao proximo depois de rodar `guia` de novo e ver `[ok]` naquele passo.
3. **Voce nao consegue fazer `/login`.** E interativo, no navegador. Peca, explique e espere a pessoa avisar.
4. **Nunca peca `/logout`**: revoga o token e a copia guardada morre junto.
5. **Nunca copie a pasta `contas/` entre PCs**: o token de renovacao muda a cada uso e a mesma copia em dois PCs
   invalida um deles. Cada PC faz o proprio cadastro.

## Como conduzir (o padrao, se a pessoa so pediu para configurar)

Abra assim: "Sao 4 passos e levam cerca de 2 minutos: 1) ler o login atual, 2) guardar esta conta, 3) guardar a
segunda conta, 4) testar a troca." Depois repita este laco ate `ESTADO: PRONTO`:

1. rode `guia`
2. leia `ESTADO:` e faca o que `AGORA:` diz
3. rode `guia` de novo e confirme o `[ok]` do passo

| Passo | O que acontece | Quem faz |
|---|---|---|
| 1. Login lido | `guia` consegue ler a conta logada. Se nao, peca `/login`. No Mac, veja a secao Mac. | a pessoa |
| 2. Primeira conta guardada | rode `salvar` | voce |
| 3. Segunda conta guardada | peca `/login` na OUTRA conta; quando ela avisar, `guia` vai mandar rodar `salvar` | pessoa, depois voce |
| 4. Troca testada | explique que troca por ~1 s e volta, peca um ok, rode `ensaio` | voce |

Para uma terceira conta (ou mais), repita o passo 3: o `guia` volta ao passo 4 e o `ensaio` testa cada conta.

## Confirmacao final (obrigatoria)

Quando `ESTADO: PRONTO`, mostre este quadro, preenchido com a saida do `guia`:

```
✔ Tudo pronto
  Contas:        <as contas guardadas>
  Troca testada: <data do ENSAIO>, ida e volta conferidas
  Como vai ser:  quando uma conta bater o limite, a sessao troca para a outra e continua sozinha;
                 aparece um aviso do sistema a cada troca
  Conferir:      /troca-conta:troca-conta status
```

Seja honesto no que foi provado: o `ensaio` prova que a troca funciona **nesta maquina**. Uma troca por limite real so
acontece quando o limite chegar; depois dela, `status` e `guia` mostram "ultima troca" como prova.

## Prova real (opcional, so se a pessoa pedir "quero ver trocando de verdade")

Troca a conta de verdade, e a sua proxima resposta ja sai pela outra conta. Se o login dela estiver revogado, voce
ficaria sem conseguir responder. Por isso, **antes**, mostre o comando de volta com o caminho completo:
`! node "<caminho do script>" trocar <email da conta original>`. Depois: rode `trocar <outra conta>`, diga que a
resposta seguinte saiu pela outra conta (a pessoa confere com `/status`), e rode `trocar <conta original>` para voltar.

## Outros pedidos

| Comando | O que faz |
|---|---|
| `guia` | onde a pessoa esta no cadastro e o proximo passo |
| `status` | contas guardadas, a ativa (`*`), quem esta no limite e ate quando, validade do login, ultima troca |
| `trocar [email]` | troca na mao (`--dry` so mostra o que faria) |
| `ensaio` | troca para cada outra conta e volta, conferindo (prova que funciona) |
| `diagnosticar` | confere o ambiente sem alterar nada; use quando algo falhar |
| `esquecer <email>` | apaga uma conta guardada |
| `config` | mostra as opcoes; `config esperar off`, `config maxEsperaHoras 3`, `config lembrete off` |

Comportamento automatico (nada a fazer): ao bater o limite a sessao troca de conta e retoma sozinha; com todas as
contas no limite o hook ja troca pra a conta que renova primeiro e espera ela renovar (ate `maxEsperaHoras`, padrao 5h30) e entao troca e retoma. Passando
disso (limite semanal), so avisa a hora da volta. Cada troca gera um aviso do sistema e uma linha em `contas/trocas.log`.

## Mac (experimental)

No Mac o Claude Code guarda o login no Keychain, nao num arquivo. O suporte foi escrito a partir do formato observado
e **nao foi testado num Mac real**, por isso vem desligado. Se o passo 1 mostrar a mensagem de Mac:

1. rode `diagnosticar`; se ele ler a credencial e mostrar o formato do Keychain, siga;
2. rode `config mac on` e volte ao `guia`;
3. o `ensaio` do passo 4 faz a primeira escrita real; se o macOS pedir acesso ao Keychain, a pessoa deve permitir.

Se algo nao fechar, o script le de volta, compara e restaura o login anterior; o motivo fica no log.

## Avisos que vale dar

- O Claude Code pode demorar alguns segundos para notar o login novo depois de uma troca.
- Se a conta nova tambem estiver no limite e o aviso nao trouxer a hora, o script estima 5h e tenta de novo depois.
- O recurso nativo "Automatic continue" do Claude Code (`/rate-limit-options`) pode retomar a mesma sessao no reset da
  conta antiga. Se gerar retomada duplicada, desligue por la.
- Trocar de conta para contornar limite pode ir contra os termos do plano. Use com contas proprias.
