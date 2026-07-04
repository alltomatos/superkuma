# Issue tracker: GitHub

Issues e PRDs deste repo vivem como GitHub issues em `alltomatos/superkuma`. Use o `gh` CLI para todas as operações.

## Convenções

- **Criar issue**: `gh issue create --title "..." --body "..."` (heredoc para corpo multi-linha).
- **Ler issue**: `gh issue view <número> --comments`.
- **Listar issues**: `gh issue list --state open --json number,title,body,labels,comments`.
- **Comentar**: `gh issue comment <número> --body "..."`.
- **Labels**: `gh issue edit <número> --add-label "..."` / `--remove-label "..."`.
- **Fechar**: `gh issue close <número> --comment "..."`.

O repo é inferido de `git remote -v` (`gh` faz isso automaticamente dentro do clone).

## ⚠️ Política de PR

Este é um **projeto próprio**, com raízes no `louislam/uptime-kuma` original. **Nenhum PR gerado por agente deve ir para lá** — ver a política anti-AI-slop em `CLAUDE.md` / `AGENTS.md`. Issues e PRs ficam neste repo, e mudanças grandes exigem revisão humana + teste manual antes de qualquer push.
