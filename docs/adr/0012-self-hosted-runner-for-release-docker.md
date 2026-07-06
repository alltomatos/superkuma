# ADR-0012: Runner self-hosted para o release Docker

- **Status:** Accepted
- **Data:** 2026-07-06

## Contexto

O workflow `release-docker.yml` (build+push da imagem `ronaldodavi/superkuma`) ficou preso na fila
de runners hospedados do GitHub por quase 1h, mesmo com zero jobs concorrentes em execução — uma
degradação pontual da infraestrutura compartilhada do GitHub Actions, não um limite de
plano/capacidade do nosso repositório. Isso motivou avaliar alternativas de independência dessa
fila compartilhada.

Considerada uma migração completa para GitLab self-hosted, mas descartada por desproporcional: o
problema real era só a fila de um workflow específico, não algo que justifique trocar toda a
plataforma (issues, PRs, histórico, hábito do time).

> **Nota de correção:** a primeira versão desta decisão registrou o runner num container isolado
> (dind sidecar, sem acesso ao Docker do host) no servidor `gnr-kvm` — infraestrutura de produção
> de um cliente (GNR), que deveria ficar reservada só ao que roda para esse cliente. Foi um erro:
> o lugar certo é o `omniroute`, servidor dedicado a CI que a organização já mantém pra outros
> repositórios próprios. Corrigido no mesmo dia; o texto abaixo já reflete o estado final correto.

## Decisão

Registramos um **runner self-hosted do GitHub Actions** no `omniroute` — servidor dedicado a CI da
própria organização, que já roda runners equivalentes para outros repositórios (`watink-hub`,
`watink-plugin-manager`, `watink-saas`, `gnranalitycs`) — e o roteamos **somente** para o
`release-docker.yml` via `runs-on: [self-hosted, omniroute]`.

- **Infra:** container `gha-repo-superkuma` (imagem `gha-runner-official`, já usada pelos outros
  runners desse host), registrado especificamente contra `alltomatos/superkuma` — um runner
  registrado a nível de repositório só recebe jobs **daquele** repositório, nunca de outro. Segue o
  mesmo padrão já estabelecido em `/opt/gha-runner/repos/docker-compose.yml` (não versionado —
  infraestrutura operacional, não código do projeto): `/var/run/docker.sock` do host montado
  diretamente (não um dind isolado), autenticado via um PAT fine-grained com permissão
  `Administration: Read and Write` no repositório.
- **Por que docker.sock direto e não um dind isolado:** o `omniroute` é infraestrutura dedicada a
  CI da própria organização (não um hypervisor de cliente rodando cargas de produção de terceiros)
  — o mesmo modelo já usado pelos outros repositórios nesse host. Manter o mesmo padrão evita uma
  segunda forma de isolamento só pro `superkuma`, sem ganho real dado que o "vizinho" nesse host já
  são só outros runners da própria organização, não VMs de cliente.
- **Escopo restrito de workflows:** só o `release-docker.yml` (disparado por tag `v*.*.*` ou
  `workflow_dispatch` manual — nunca por PR) usa esse runner. O `Auto Test` e demais workflows
  disparados por PR **continuam nos runners hospedados do GitHub**. Isso é deliberado: o repo é
  **público**, e um runner self-hosted rodando código de PR de um contribuidor externo (ou de uma
  conta comprometida) seria uma superfície de ataque real.

## Consequências

- (+) `release-docker.yml` não depende mais da fila compartilhada do GitHub Actions.
- (+) Consistente com a infraestrutura de CI que a organização já opera — nada novo pra manter além
  de mais uma entrada no compose já existente.
- (−) Registro por repositório: se o PAT perder a permissão `Administration` no repo ou o acesso ao
  repositório for revogado, o container entra em loop de restart até ser corrigido (aconteceu
  durante a configuração — diagnosticado via `curl` direto na API de registration-token, que
  devolveu 403 "Resource not accessible by personal access token").
- (−) Ponto único: se o `omniroute` cair, o release Docker fica bloqueado até o runner voltar (mesmo
  risco de qualquer self-hosted runner sem redundância) — mas os outros repositórios que já
  dependem desse host têm exatamente o mesmo risco, então não é um risco novo introduzido por essa
  decisão.
- (−) **amd64-only por enquanto.** Não investigamos ainda suporte a arm64 nesse runner (o host usa
  Docker direto, não um dind aninhado, então o problema de propagação de QEMU/`binfmt_misc` que
  bloqueou a tentativa original no gnr-kvm provavelmente não se aplica aqui — mas isso não foi
  testado). `release-docker.yml` builda só `linux/amd64` por ora; retomar multi-arch fica como
  débito técnico não resolvido nesta decisão.

## Alternativas consideradas

- **Migrar para GitLab self-hosted:** resolveria o problema, mas é uma troca de plataforma inteira
  para consertar a fila de um workflow. Descartada por desproporcional.
- **Container isolado com dind sidecar (tentativa original, no gnr-kvm):** revertida — além do
  local errado (infra de cliente), a organização já mantém um padrão funcional de runners no
  `omniroute`; manter dois modelos de isolamento diferentes pra runners da mesma organização seria
  inconsistência sem benefício real.
- **Mover também o `Auto Test` para self-hosted:** rejeitada — esse workflow roda em todo PR,
  inclusive de forks externos, o que exporia a infraestrutura a código não confiável.
- **Aguardar o GitHub Actions normalizar:** era a opção "não fazer nada"; resolveria o incidente
  pontual, mas não a dependência estrutural da fila compartilhada para esse workflow específico.
