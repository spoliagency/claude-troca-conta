# troca-conta

Plugin do Claude Code. Quando uma conta bate o limite de uso, **troca para a outra e retoma a sessao
sozinho**, sem ninguem digitar "continua". Com todas as contas no limite, **espera a primeira renovar** e
retoma. Funciona com 2 ou mais contas.

> Uso com contas proprias. Alternar contas para contornar limite pode ir contra os termos do plano; o risco
> de bloqueio de conta e de quem usa. Mantenha o repositorio privado.

## Instalar (em cada PC)

```
claude plugin marketplace add spoliagency/claude-troca-conta
claude plugin install troca-conta@spoli-ferramentas
```

Reinicie o Claude Code (hook novo so vale em sessao nova). Enquanto o cadastro nao estiver completo, cada
sessao nova abre com um aviso: `troca-conta: so 1 conta guardada. Digite /troca-conta:troca-conta ...`.

## Cadastro guiado (cerca de 2 minutos)

Digite **`/troca-conta:troca-conta`**. O assistente conduz 4 passos, um de cada vez, e antes de cada um le o estado
real (login e contas guardadas), nao a conversa:

| Passo | O que acontece | Prova que o passo fechou |
|---|---|---|
| 1. Login lido | confere a conta logada agora | `[ok] 1. Login do Claude Code lido: a@x.com` |
| 2. Primeira conta guardada | o assistente roda `salvar` | `[ok] 2.` |
| 3. Segunda conta guardada | **voce** digita `/login` e entra na OUTRA conta (nunca `/logout`); o assistente roda `salvar` | `[ok] 3.` com login valido nas duas |
| 4. Troca testada | o assistente roda `ensaio`: troca para cada outra conta e volta, conferindo login e identidade lidos de volta | `[ok] 4.` e `ESTADO: PRONTO` |

No fim ele mostra o quadro **"Tudo pronto"** com as contas, a data do ensaio e o que vai acontecer. Depois de uma troca
por limite de verdade, `status` e `guia` mostram a **"ultima troca"** (de quem para quem, quando e por que): essa e a
confirmacao de que funcionou no uso real. Os mesmos comandos funcionam direto no terminal (`guia`, `salvar`, `ensaio`).

Cada PC faz o proprio cadastro. **Nao copie a pasta `~/.claude/contas` entre PCs**: o token de renovacao
muda a cada uso, e a mesma copia em dois PCs invalida um deles.

## Como funciona

```
conta A bate o limite
   -> Claude Code chama o hook StopFailure (matcher rate_limit)
   -> troca claudeAiOauth + oauthAccount pela conta B (o resto do login nao e tocado)
   -> o hook sai com codigo 2 (asyncRewake): a sessao acorda com "retome de onde parou"
   -> o Claude Code ja le o login novo: o proximo pedido sai com o token da B
o limite e AVISADO antes de estourar (o modelo para sozinho, turno termina normal, sem erro)
   -> o hook Stop le o transcript, acha a nota "usage limit reached" do Claude Code e faz a mesma troca
   -> acorda a sessao dizendo pra continuar o que ficou pendente na ultima resposta
as duas no limite
   -> descobre qual das contas renova PRIMEIRO e ja troca pra ela na hora (se for a atual, fica)
   -> o hook fica vivo, conferindo a hora a cada 30 s, ate ela renovar (max 5h30), e entao acorda a sessao
a conta ativa tem o login REVOGADO (hook StopFailure, matcher authentication_failed)
   -> marca a conta como revogada, troca pra outra conta que esteja livre (ou espera a que renova primeiro) e acorda a sessao
   -> avisa que so aquela conta precisa de /login; quando ela fizer, o plugin guarda o login novo e a marca some
a cada turno (hook Stop) e ao abrir a sessao
   -> se o Claude Code renovou o token da conta ativa, o slot guardado dela e atualizado
```

**Por que o slot acompanha o login:** o token de renovacao so vale uma vez. Cada renovacao gera um novo e invalida o
anterior, e reusar um ja gasto faz o servidor revogar a conta toda. Se o slot so fosse gravado na hora de sair da
conta, ele ficaria dias atras e a proxima troca para ela usaria um token gasto (foi o que revogou a conta em 03/11).
O sync nao grava no escuro: pula se o login lido for o de outra conta guardada (arquivo regravado por sessao antiga
ou lido no meio de uma troca) ou se for mais velho que o slot, e nunca cria slot de conta nao cadastrada.

Cada troca gera um aviso do sistema e uma linha em `~/.claude/contas/trocas.log`.

## Comandos

`node <plugin>/scripts/trocar-conta.js <comando>` (ou pela skill `troca-conta`):

| Comando | O que faz |
|---|---|
| `guia` | onde voce esta no cadastro (passo X de 4) e o que fazer agora; `ESTADO: PRONTO` ao final |
| `salvar` | guarda a conta logada agora |
| `sincronizar` | guarda de novo o login da conta ativa se o Claude Code o renovou (o hook faz isso a cada turno) |
| `ensaio` | troca para cada outra conta e volta, conferindo (prova que funciona nesta maquina) |
| `status` | contas guardadas, a ativa, quem esta no limite e ate quando, validade do login, ultima troca |
| `trocar [email] [--dry]` | troca na mao |
| `diagnosticar` | confere o ambiente sem alterar nada |
| `esquecer <email>` | apaga uma conta guardada |
| `config [chave valor]` | `esperar on/off`, `maxEsperaHoras N`, `mac on/off`, `lembrete on/off`, `antecipar on/off` (trocar ja no aviso de limite, ligado por padrao) |

## Plataformas

| Sistema | Situacao |
|---|---|
| Windows | **testado de verdade** (suite + E2E com servidor falso de API) |
| Linux / WSL | mesmo caminho do Windows (arquivo `.credentials.json`); logica testada, nao rodado em Linux real |
| Mac | **experimental, nao testado em Mac real.** O login fica no Keychain (item unico ou dividido em pedacos). Vem desligado: rode `diagnosticar`, depois `config mac on`. Testado so contra um `security` falso |

## Variaveis que o script trata

- **`CLAUDE_CONFIG_DIR`**: login, identidade e contas guardadas vao para o diretorio configurado; no Mac o
  nome do item do Keychain leva o hash do caminho, como no Claude Code.
- **Fuso horario**: o aviso do Claude traz a hora de renovacao com o fuso (`resets 6:27pm (America/Sao_Paulo)`);
  e convertida certo mesmo se a maquina estiver em outro fuso.
- **`trustedDeviceToken`**: pertence a conta+dispositivo; acompanha a conta na troca.
- **Token de renovacao vencido ou login revogado** numa conta guardada: a conta e pulada e o aviso diz para fazer `/login` nela.
  A marca de revogada e o hash do token morto, entao some sozinha quando a conta ganha token novo. Troca manual
  (`trocar <email>`) ignora a marca: a decisao e sua.
- **Nao da pra impedir** que uma sessao antiga do Claude Code, aberta antes da troca, regrave o proprio login no
  arquivo (o plugin so detecta e nao sobrescreve o slot com ele). Feche sessoes `claude` esquecidas.
- **Varias sessoes abertas**: dividem o mesmo login; uma sessao vizinha so e acordada, sem marcar a conta nova
  como no limite por engano. Varias esperas simultaneas: uma trava de arquivo garante que so uma troca e acorda.
- **Gravacao ruim**: o script le de volta e compara; se nao bater, restaura o login anterior.
- **Aviso do sistema**: balao no Windows, `osascript` no Mac, `notify-send` no Linux (se existir).
- **Node**: precisa de Node 18+ no PATH (o hook roda `node`).

## Limites conhecidos

- Testado com o Claude Code **2.1.303** (hooks `StopFailure` e `asyncRewake`). Versoes sem eles nao funcionam.
- Aviso de limite **sem horario** (ex.: limite semanal): estima 5h e tenta de novo; se passar de `maxEsperaHoras`, so avisa.
- O Claude Code tem um recurso nativo, **"Automatic continue"** (`/rate-limit-options`), que retoma a mesma sessao
  no reset da conta antiga. Nao foi possivel provocar isso no teste automatizado (e do modo interativo). Se gerar
  retomada duplicada, desligue por la.
- **Troca no aviso de limite (v0.3.0):** perto do limite o Claude Code injeta uma nota na conversa e o modelo encerra
  o turno sozinho; isso nao gera erro, entao so o hook `Stop` enxerga. Ele procura a nota `usageLimitNote:"wrap_up"`
  no fim do transcript (so no turno que acabou, so nota de ate 15 min, e cada nota so uma vez). O formato foi copiado
  de uma sessao real, mas a nota do E2E e gravada por um injetor de teste, nao pelo cliente: se uma versao nova do
  Claude Code mudar o nome do campo, o aviso deixa de ser detectado e volta ao comportamento antigo (troca so
  quando o limite estoura de verdade). Fica registrado em `trocas.log` como `AVISO de limite antes de estourar`.
  Ainda nao provado: interacao com o "Automatic continue" nativo, que tambem mostra `continuing automatically at ...`.
- O modo interativo (TUI) nao foi coberto pelo E2E automatico (usa `claude -p` em sessao longa). O mecanismo de
  acordar e o de ler o login novo sao os mesmos, mas a primeira troca real vale conferir olhando.
- O assistente guiado e testado onde e deterministico: `guia`, `ensaio`, `lembrete`, o hook de inicio de sessao e
  se a skill carrega com o caminho do script resolvido. **Nao** ha teste automatizado de um modelo real
  conduzindo a conversa dos 4 passos: a skill amarra o modelo ao `guia` para isso nao depender de memoria, mas
  o primeiro uso real vale acompanhar.
- Se existir `.device-keys.json`, o Claude pode pedir para registrar o dispositivo de novo na primeira troca.
- No Mac, as contas guardadas ficam em arquivo (`chmod 600`) dentro de `~/.claude/contas`, nao no Keychain.

## Testes

```
npm test                 # unitarios + fluxo + Keychain falso + assistente guiado + troca no aviso de limite (71 testes, rapido)
npm run validar          # claude plugin validate --strict
E2E_CLAUDE=<claude.exe> npm run e2e [troca|aviso|ambas]  # limite de verdade, com servidor falso de API
E2E_CLAUDE=<claude.exe> node tests/e2e/e2e-lembrete.js  # aviso de inicio de sessao, no Claude Code real
```

O E2E instala o plugin pelo marketplace num diretorio isolado com espacos no caminho, sobe um servidor falso
que devolve 429 como o da Anthropic, roda `claude -p` em sessao longa e confere: hook chamado, login trocado
**durante a sessao**, proximo pedido com o token da outra conta, retomada sem ninguem digitar. Nao usa conta real.

## Desinstalar

```
claude plugin uninstall troca-conta
```

As contas guardadas ficam em `~/.claude/contas` (apague a pasta se quiser; ela contem tokens).
