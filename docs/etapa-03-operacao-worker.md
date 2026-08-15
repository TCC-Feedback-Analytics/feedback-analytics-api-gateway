# Etapa 03 — Operação do worker (drain por cron)

> Como a análise assíncrona **roda em produção** sem um host always-on. O worker é
> um endpoint que um **cron externo** "cutuca" periodicamente; cada chamada drena
> um lote de jobs da fila e volta — cabe no modelo serverless da Vercel.

## Como funciona

```
Cron externo (a cada ~1 min)
   → POST https://<gateway>/api/internal/worker/tick   (header x-worker-token)
   → drainJobs(): processa até IA_WORKER_BATCHES_PER_TICK lotes, respeitando o
     rate limiter; jobs que não cabem continuam no próximo tick.
```

Nada de processo sempre-ligado, container ou Dockerfile. O mesmo `drainJobs()` pode
virar um loop always-on num host externo no futuro (ver etapa 08) — sem reescrita.

## Variáveis de ambiente (na Vercel, projeto `api-gateway`)

| Var | Papel | Sugestão |
|---|---|---|
| `IA_ASYNC_ENABLED` | Liga o modo assíncrono (senão, síncrono antigo) | `true` só depois de validar |
| `WORKER_TICK_TOKEN` | Protege o `/tick` (o cron envia no header `x-worker-token`) | `openssl rand -hex 32` |
| `IA_WORKER_BATCHES_PER_TICK` | Máx. de lotes (chamadas ao LLM) por tick | `3` (ajuste ao `maxDuration`/plano) |
| `IA_RPM_LIMIT` | Chamadas ao LLM por minuto (0 = sem limite) | conforme a cota do provedor |
| `IA_RPD_LIMIT` | Chamadas ao LLM por dia (a cota que hoje estoura) | conforme a cota do provedor |

## Configurar o cron externo

**Opção A — cron-job.org (grátis, granularidade de 1 min — recomendado):**
1. Crie um cronjob apontando para `POST https://<gateway>/api/internal/worker/tick`.
2. Intervalo: a cada 1 minuto.
3. Header: `x-worker-token: <WORKER_TICK_TOKEN>`.

**Opção B — GitHub Actions (mínimo ~5 min, pode atrasar):**
```yaml
# .github/workflows/worker-tick.yml
name: worker-tick
on:
  schedule:
    - cron: '*/5 * * * *' # a cada 5 min (mínimo do GitHub)
  workflow_dispatch:
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X POST "$GATEWAY_URL/api/internal/worker/tick" \
            -H "x-worker-token: $WORKER_TICK_TOKEN"
        env:
          GATEWAY_URL: ${{ secrets.GATEWAY_URL }}
          WORKER_TICK_TOKEN: ${{ secrets.WORKER_TICK_TOKEN }}
```
(Requer os secrets `GATEWAY_URL` e `WORKER_TICK_TOKEN` no repositório.)

## Ajuste de ritmo (tuning)

- **`IA_WORKER_BATCHES_PER_TICK` × `maxDuration`:** cada lote é uma chamada ao LLM
  (~10–30s). No plano free (corte ~60s) prefira `2–3`; com `maxDuration:300` (Pro),
  pode subir. O que não couber num tick continua no próximo — sem perda.
- **Frequência do cron × rate limit:** o `IA_RPM_LIMIT` é a trava real de cota; o
  cron só define a latência de início. Um tick por minuto é suficiente para o TCC.
- **Back-pressure:** se a cota estourar, os jobs viram `waiting_budget` e retomam
  sozinhos na próxima janela — nenhum job falha por cota.

## Dev local

Não há cron em dev. Enquanto testa, cutuque o tick num loop (token vazio em dev):
```bash
while true; do curl -s -X POST http://localhost:3000/api/internal/worker/tick; echo; sleep 3; done
```

## Verificação em produção (smoke)

1. Ligue `IA_ASYNC_ENABLED=true` e o cron.
2. Dispare uma análise pela UI → deve responder na hora (202) e a barra "X de Y" avançar.
3. Confira nos logs do tick o `{ processed, results }`.
4. Uma análise com 40+ feedbacks conclui **sem timeout**.
