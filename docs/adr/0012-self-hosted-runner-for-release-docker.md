# ADR-0012: Runner self-hosted para o release Docker

- **Status:** Accepted (escopo ampliado em 2026-07-07, ver nota abaixo)
- **Data:** 2026-07-06

> **Atualização 2026-07-07:** a rejeição de mover `Auto Test`/`validate` para o `omniroute` (ver
> "Decisão" e "Alternativas consideradas" abaixo) foi revisitada, não revertida. A fila
> compartilhada do GitHub Actions continuou lenta o suficiente para incomodar no dia a dia, e a
> objeção original — código de PR de fork externo rodando na nossa infra — tinha uma solução mais
> simples do que "não fazer isso": condicionar `runs-on` a
> `github.event.pull_request.head.repo.full_name == github.repository`. PRs de uma branch deste
> mesmo repositório (o caso comum aqui — não recebemos PRs de forks externos no dia a dia) rodam no
> `omniroute`; PRs de fork continuam no GitHub-hosted, preservando a garantia original. Aplicado em
> `auto-test.yml` (jobs `auto-test` — só a perna `ubuntu-22.04`, já que macOS/Windows/arm64 não
> rodam no `omniroute`/são não-verificados nele —, `check-linters`, `e2e-test`) e `validate.yml`
> (`json-yaml-validate`, `validate`). `CodeQL`/`zizmor` (scans de segurança first-party do GitHub) e
> os workflows `pull_request_target` que não fazem checkout de código de PR (`pr-title.yml`,
> `pr-description-check.yml`) permanecem no GitHub-hosted — não há ganho em movê-los e/ou já não têm
> o problema de fila que motivou isso.
>
> **Dois problemas reais de ambiente encontrados testando isso no próprio PR desse ajuste:**
>
> 1. **`armv7-simple-test` NÃO foi movido** — ficou permanentemente em `ubuntu-latest`. Esse job
>    roda `docker run -v $PWD:/workspace ...` para testar `npm ci` sob QEMU (arm/v7); no `omniroute`
>    isso resultou em `/workspace` vazio dentro do container (npm ci falhou com
>    `EUSAGE: package-lock.json not found`). Causa: o runner roda dentro de um container com o
>    `docker.sock` do HOST montado direto (não um dind aninhado — ver "Decisão" acima), então
>    `-v $PWD:/workspace` é resolvido pelo daemon do HOST contra o `$PWD` do runner _dentro do seu
>    próprio container_ — um caminho que não existe no host, então o Docker cria um bind-mount vazio
>    silenciosamente em vez de falhar. Corrigir exigiria trocar o mecanismo de transferência (volume
>    nomeado + `docker cp`, por exemplo) — fora do escopo desta mudança.
> 2. **Falta `libatomic1` na imagem do runner (`gha-runner-official`)** — qualquer job que rode
>    `actions/setup-node` + `node ...` no `omniroute` falha com
>    `node: error while loading shared libraries: libatomic.so.1: cannot open shared object file`.
>    Não é específico de uma versão do Node; é uma lib de sistema (Debian/Ubuntu `libatomic1`)
>    ausente na imagem base do runner. Precisa ser instalada na imagem/container do runner no
>    `omniroute` (fora deste repositório) antes que `auto-test`, `check-linters` e `validate`
>    consigam de fato passar quando roteados para lá.

> **Atualização 2026-07-07 (CI focada no artefato de container):** com o CI já rodando no
> `omniroute`, a matriz de testes foi realinhada ao que a imagem realmente ship — um único artefato
> `node:20-bookworm-slim`, `linux/amd64` (Dockerfile raiz + `release-docker.yml`). Mudanças:
>
> - **`auto-test` colapsou de 5 pernas para 1** (só `ubuntu-22.04`/node 20). As pernas node 24/25
>   (runtime não shippado) e `ubuntu-22.04-arm` (arch não shippada, amd64-only) foram removidas.
> - **`armv7-simple-test` foi DELETADO** — arch não shippada, e já quebrado no `omniroute` (ver
>   item 1 acima). Não vale um mecanismo de transferência alternativo para testar uma arch que a
>   imagem nunca contém.
> - **`CodeQL`: removida a perna `go`** — não há Go no artefato (só scripts em `extra/`).
> - **Adicionado `docker-build-smoke`**: builda o Dockerfile real (`--platform linux/amd64`) em todo
>   PR, sobe o container e faz poll do HTTP até responder — a primeira vez que o CI valida o
>   artefato de fato (dumb-init + `server/server.js` + deps de runtime baked-in) em vez de rodar
>   fonte no runner. Depende do `docker.sock` do host (que o `omniroute` já monta).
> - **Testes que dependem de infra externa passaram a pular de forma limpa** via
>   `test/backend-test/util-container.js`: os testes testcontainers (DB/fila/SNMP) pulam sem Docker
>   (`skipTestcontainers()`, override `SKIP_TESTCONTAINERS=1`); os de internet ao vivo (RDAP, TLS
>   externo) são opt-in em CI (`RUN_NETWORK_TESTS=1`). O `check-translations` deixou de buscar o
>   `en.json` do `louislam/uptime-kuma` (acoplava o fork ao upstream, §2).
> - **`e2e-test`** fixado em Node 20 e instala as libs de navegador via `sudo playwright
install-deps` (sudo sem senha no runner), sem depender de provisionamento manual do container.
> - **Removidos 5 workflows de build/release legados** (`build-docker-pr-test`, `build-docker-base`,
>   `release-beta`, `release-final`, `release-nightly`) que buildavam a imagem `base2` retirada ou
>   usavam o caminho QEMU+GHCR divergente. O caminho de release real é `auto-release.yml` (tag) →
>   `release-docker.yml` (imagem amd64 → Docker Hub).
> - **Instalado no `omniroute`** (7 runners registrados para o repo, para paralelizar a fila):
>   `libatomic1` (item 2 acima) + `iputils-ping` + libs de navegador do Playwright. **Caveat de
>   durabilidade:** esses `apt install` são no container em execução e se perdem se os runners forem
>   recriados; o fix durável é assá-los na imagem `gha-runner-official` (infra fora deste repo). As
>   libs do Playwright já são reaplicadas pelo próprio job de e2e (`install-deps`).

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
