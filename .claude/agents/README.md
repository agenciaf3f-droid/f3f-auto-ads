# Subagents do f3f-auto-ads

Cada arquivo `.md` nesta pasta = 1 subagente. O Claude "main" lê o `description`
de cada um e **delega sozinho** quando a tarefa bate. Você também pode forçar.

## Os agentes atuais

| Agente | Quando dispara | Modelo | Pode |
|--------|----------------|--------|------|
| `meta-ads-expert` | mexer em publicação Meta / presets FASE 1/2/3/L.T / erro Graph API | opus | ler + editar |
| `edge-debugger` | publicação falhou / investigar edge function | sonnet | ler + rodar cmd (diagnóstico) |
| `frontend-guard` | editar React/TS em `src/**` | sonnet | ler + editar + `tsc` |

## 3 formas de disparar (do vídeo)

1. **Linguagem natural** (mais simples) — só descreva a tarefa. O main escolhe:
   > "a FASE 3 tá dando erro 100 na publicação, investiga"
   → main chama `meta-ads-expert` sozinho.
2. **@-mention / nome explícito** (garante o agente certo):
   > "usa o edge-debugger pra ver por que o meta-publish falhou"
3. **Sessão inteira num agente** (terminal):
   ```bash
   claude --agent meta-ads-expert
   ```

## Anatomia de um agente (o `.md`)

```markdown
---
name: nome-do-agente          # como você chama ele
description: >-               # O MAIS IMPORTANTE — diz QUANDO usar.
  Use PROACTIVELY quando ...  # "Use PROACTIVELY"/"MUST be used" = delega mais.
tools: Read, Edit, Grep, Glob, Bash   # opcional. Omitir = herda TUDO (inclui MCP).
model: opus | sonnet | haiku          # opcional. haiku=barato/leitura,
---                                   # sonnet=código, opus=raciocínio pesado.
Instruções (o "manual do funcionário"): personalidade + passo a passo.
```

Regras de ouro:
- **`description` decide a delegação.** Escreva "use QUANDO...", não "faz X". Sem isso o main não delega.
- **Menos tools = mais seguro.** Read-only p/ pesquisa; Edit/Write só em quem constrói.
- **Modelo = custo.** haiku p/ ler/buscar, sonnet p/ escrever/revisar, opus só p/ o difícil.

## Criar um agente novo (2 min)

1. Crie `./.claude/agents/meu-agente.md` com o bloco acima.
2. Capriche no `description` (é o gatilho).
3. Peça a tarefa em linguagem natural — o main já enxerga o agente novo.

> Escopo: agente em `.claude/agents/` = só este projeto. Em `~/.claude/agents/` = todos.
> Quer orquestração paralela/pesada (fan-out em N arquivos)? Aí é a ferramenta **Workflow**
> (ultracode), não subagente `.md`. Um trabalho, um veículo — não faça os dois pro mesmo.
