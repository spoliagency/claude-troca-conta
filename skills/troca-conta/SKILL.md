---
name: troca-conta
description: Instala, confere e opera a troca automatica de conta do Claude Code quando uma conta bate o limite de uso. Use quando a pessoa pedir para cadastrar ou adicionar uma conta, ver qual conta esta ativa, conferir se a troca automatica esta funcionando, trocar de conta na mao, esquecer uma conta, ou disser que "o limite acabou" e quer alternar entre contas. Tambem para configurar num PC novo ou no Mac.
---

# Troca de conta do Claude Code

O plugin ja registra sozinho o hook que, ao bater o limite, troca para a outra conta guardada e
retoma a sessao. Esta skill cuida do que o hook nao faz: **cadastrar as contas**, **conferir** e
**operar**. Todos os comandos usam o mesmo script:

```
node "${CLAUDE_SKILL_DIR}/../../scripts/trocar-conta.js" <comando>
```

Se `${CLAUDE_SKILL_DIR}` aparecer sem ser trocado pelo caminho, ache o plugin com
`claude plugin list --json` (campo `installPath` de `troca-conta`) e use `<installPath>/scripts/trocar-conta.js`.

## 1. Sempre comece por `diagnosticar`

Nao altera nada. Mostra: sistema e Node, versao do Claude, onde o login esta guardado, qual conta esta
ativa, quantas contas estao guardadas, validade do token de renovacao de cada uma e avisos.
Se mostrar `FALHA`, resolva antes de seguir.

## 2. Cadastrar contas (a pessoa precisa participar)

Voce **nao consegue** logar por ela. O login e interativo, no navegador. Conduza assim, um passo por vez:

1. Com a conta A logada agora: rode `salvar`. Confirme com `status`.
2. Peca para ela rodar `/login` e entrar na conta B. **Nunca `/logout`**: o logout revoga o token e a
   copia guardada morre junto.
3. Com a B logada: rode `salvar` de novo. `status` tem que listar as duas.
4. Para uma terceira conta (ou mais): repita 2 e 3. Nao ha limite de contas.

Cada PC faz o proprio cadastro. **Nunca copie a pasta `contas/` de um PC para outro**: o token de
renovacao muda a cada uso, e a mesma copia em dois PCs invalida um dos dois.

## 3. Operar

| Comando | O que faz |
|---|---|
| `status` | contas guardadas, a ativa (`*`), quem esta no limite e ate quando, validade do login |
| `trocar [email]` | troca agora, na mao (`--dry` so mostra o que faria) |
| `esquecer <email>` | apaga uma conta guardada |
| `config` | mostra as opcoes; `config esperar off` desliga a espera; `config maxEsperaHoras 3` |

Comportamento automatico (nao precisa fazer nada): ao bater o limite a sessao troca de conta e retoma
sozinha; com todas as contas no limite o hook espera a primeira renovar (ate `maxEsperaHoras`, padrao
5h30) e entao troca e retoma. Passando disso (limite semanal), so avisa a hora da volta.
Cada troca gera um aviso do sistema e uma linha em `contas/trocas.log`.

## 4. Mac (experimental)

No Mac o Claude Code guarda o login no Keychain, nao num arquivo. O suporte aqui foi escrito a partir do
formato observado e **nao foi testado num Mac real**. Por isso vem desligado:

1. Rode `diagnosticar`. Se ler a credencial e mostrar o formato do Keychain, siga.
2. Rode `config mac on`.
3. Teste com `trocar --dry`, depois um `trocar` manual, e confira com `status` e abrindo uma sessao.
4. A primeira leitura pode abrir um aviso do macOS pedindo acesso ao Keychain: permita.

Se algo nao fechar, o script nao altera o login (le de volta e confere) e registra o motivo no log.

## Limites que vale avisar a pessoa

- A troca vale na sessao aberta, mas o Claude Code pode demorar alguns segundos para notar o login novo.
- Se a conta nova tambem estiver no limite e o aviso nao trouxer a hora, o script estima 5h e tenta de novo depois.
- O recurso nativo "Automatic continue" do Claude Code (`/rate-limit-options`) pode retomar a mesma sessao no
  reset da conta antiga. Se isso gerar uma retomada duplicada, desligue por la.
- Trocar de conta para contornar limite pode ir contra os termos do plano. Use com contas proprias.
