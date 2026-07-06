# ADR-0012: Runner self-hosted isolado para o release Docker

- **Status:** Accepted
- **Data:** 2026-07-06

## Contexto

O workflow `release-docker.yml` (build+push multi-arch da imagem `ronaldodavi/superkuma`) ficou
preso na fila de runners hospedados do GitHub por quase 1h, mesmo com zero jobs concorrentes em
execução — uma degradação pontual da infraestrutura compartilhada do GitHub Actions, não um
limite de plano/capacidade do nosso repositório. Isso motivou avaliar alternativas de
independência dessa fila compartilhada.

Considerada uma migração completa para GitLab self-hosted, mas descartada por desproporcional: o
problema real era só a fila de um workflow específico, não algo que justifique trocar toda a
plataforma (issues, PRs, histórico, hábito do time).

## Decisão

Registramos um **runner self-hosted do GitHub Actions**, rodando em um **container Docker
isolado** no servidor `gnr-kvm` (não na VM/host de produção diretamente), e o roteamos **somente**
para o `release-docker.yml` via `runs-on: [self-hosted, gnr-docker]`.

- **Isolamento:** o runner roda num container próprio, sem montar `/var/run/docker.sock` do host
  e sem acesso à rede padrão do Docker do host. Builds Docker (incluindo multi-arch via QEMU) são
  feitos contra um sidecar **Docker-in-Docker (`dind`)** dedicado, numa rede Docker privada
  (`runner-net`) que só o runner enxerga — sem alcance às outras VMs/containers de clientes que já
  rodam no gnr-kvm (ex: SQLSYNC2, SRV-FILE01, etc.).
- **Escopo restrito de workflows:** só o `release-docker.yml` (disparado por tag `v*.*.*` ou
  `workflow_dispatch` manual — nunca por PR) usa esse runner. O `Auto Test` e demais workflows
  disparados por PR **continuam nos runners hospedados do GitHub**. Isso é deliberado: o repo é
  **público**, e um runner self-hosted rodando código de PR de um contribuidor externo (ou de uma
  conta comprometida) seria uma superfície de ataque real contra a infraestrutura do gnr-kvm.
- **Infra:** `docker-compose` com 2 serviços (`dind` privilegiado + `runner` baseado em
  `myoung34/github-runner`), vive fora do repositório em `/opt/gh-runner/` no gnr-kvm (não
  versionado — é infraestrutura operacional, não código do projeto).

## Consequências

- (+) `release-docker.yml` não depende mais da fila compartilhada do GitHub Actions.
- (+) Blast radius contido: mesmo que o runner seja comprometido, ele não tem acesso ao Docker do
  host nem às outras VMs/containers do gnr-kvm.
- (−) `dind` roda com `privileged: true` (exigência do Docker-in-Docker) — aceitável porque está
  isolado numa rede própria e só builda a partir de um workflow que não aceita código de PR
  externo.
- (−) Nova peça de infraestrutura para manter (atualizar a imagem do runner, monitorar se está
  `online`, renovar registro se o container for recriado do zero).
- (−) Ponto único: se o gnr-kvm cair, o release Docker fica bloqueado até o runner voltar (mesmo
  risco que qualquer self-hosted runner sem redundância).

## Alternativas consideradas

- **Migrar para GitLab self-hosted:** resolveria o problema, mas é uma troca de plataforma inteira
  para consertar a fila de um workflow. Descartada por desproporcional.
- **Self-hosted runner direto no host gnr-kvm (sem container):** mais simples, mas roda código do
  workflow com acesso direto ao Docker/rede do host de produção — risco maior num repo público.
  Descartada.
- **Mover também o `Auto Test` para self-hosted:** rejeitada — esse workflow roda em todo PR,
  inclusive de forks externos, o que exporia a infraestrutura a código não confiável.
- **Aguardar o GitHub Actions normalizar:** era a opção "não fazer nada"; resolveria o incidente
  pontual, mas não a dependência estrutural da fila compartilhada para esse workflow específico.
