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

Reinicie o Claude Code (hook novo so vale em sessao nova). Depois cadastre as contas:

1. Logada na conta A: `/troca-conta:troca-conta` (a skill conduz) ou direto
   `node <plugin>/scripts/trocar-conta.js salvar`.
2. Rode `/login` e entre na conta B. **Nunca `/logout`**: o logout revoga o token e a copia guardada morre.
3. Logada na B: `salvar` de novo. `status` tem que listar as duas. Repita para mais contas.

Cada PC faz o proprio cadastro. **Nao copie a pasta `~/.claude/contas` entre PCs**: o token de renovacao
muda a cada uso, e a mesma copia em dois PCs invalida um deles.

## Como funciona

```
conta A bate o limite
   -> Claude Code chama o hook StopFailure (matcher rate_limit)
   -> troca claudeAiOauth + oauthAccount pela conta B (o resto do login nao e tocado)
   -> o hook sai com codigo 2 (asyncRewake): a sessao acorda com "retome de onde parou"
   -> o Claude Code ja le o login novo: o proximo pedido sai com o token da B
as duas no limite
   -> o hook fica vivo, conferindo a hora a cada 30 s, ate a primeira renovar (max 5h30)
   -> troca (ou fica) na conta liberada e acorda a sessao
```

Cada troca gera um aviso do sistema e uma linha em `~/.claude/contas/trocas.log`.

## Comandos

`node <plugin>/scripts/trocar-conta.js <comando>` (ou pela skill `troca-conta`):

| Comando | O que faz |
|---|---|
| `salvar` | guarda a conta logada agora |
| `status` | contas guardadas, a ativa, quem esta no limite e ate quando, validade do login |
| `trocar [email] [--dry]` | troca na mao |
| `diagnosticar` | confere o ambiente sem alterar nada |
| `esquecer <email>` | apaga uma conta guardada |
| `config [chave valor]` | `esperar on/off`, `maxEsperaHoras N`, `mac on/off` |

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
- **Token de renovacao vencido** numa conta guardada: a conta e pulada e o aviso diz para fazer `/login` nela.
- **Varias sessoes abertas**: dividem o mesmo login; uma sessao vizinha so e acordada, sem marcar a conta nova
  como no limite por engano. Duas esperas simultaneas: so uma acorda.
- **Gravacao ruim**: o script le de volta e compara; se nao bater, restaura o login anterior.
- **Aviso do sistema**: balao no Windows, `osascript` no Mac, `notify-send` no Linux (se existir).
- **Node**: precisa de Node 18+ no PATH (o hook roda `node`).

## Limites conhecidos

- Testado com o Claude Code **2.1.303** (hooks `StopFailure` e `asyncRewake`). Versoes sem eles nao funcionam.
- Aviso de limite **sem horario** (ex.: limite semanal): estima 5h e tenta de novo; se passar de `maxEsperaHoras`, so avisa.
- O Claude Code tem um recurso nativo, **"Automatic continue"** (`/rate-limit-options`), que retoma a mesma sessao
  no reset da conta antiga. Nao foi possivel provocar isso no teste automatizado (e do modo interativo). Se gerar
  retomada duplicada, desligue por la.
- O modo interativo (TUI) nao foi coberto pelo E2E automatico (usa `claude -p` em sessao longa). O mecanismo de
  acordar e o de ler o login novo sao os mesmos, mas a primeira troca real vale conferir olhando.
- Se existir `.device-keys.json`, o Claude pode pedir para registrar o dispositivo de novo na primeira troca.
- No Mac, as contas guardadas ficam em arquivo (`chmod 600`) dentro de `~/.claude/contas`, nao no Keychain.

## Testes

```
npm test                 # unitarios + fluxo + Keychain falso (rapido)
npm run validar          # claude plugin validate --strict
E2E_CLAUDE=<claude.exe> npm run e2e [troca|ambas]
```

O E2E instala o plugin pelo marketplace num diretorio isolado com espacos no caminho, sobe um servidor falso
que devolve 429 como o da Anthropic, roda `claude -p` em sessao longa e confere: hook chamado, login trocado
**durante a sessao**, proximo pedido com o token da outra conta, retomada sem ninguem digitar. Nao usa conta real.

## Desinstalar

```
claude plugin uninstall troca-conta
```

As contas guardadas ficam em `~/.claude/contas` (apague a pasta se quiser; ela contem tokens).
