# Operação da IA — sempre assíncrona

Análise e relatório sempre respondem HTTP 202 com `jobId`. Não existe opção de
execução síncrona no ambiente; a variável legada `IA_ASYNC_ENABLED` é ignorada
e pode ser removida.

## Desenvolvimento local

1. No Gateway: `npm run db:local:up` (PostgreSQL Docker).
2. No ia-analyze: `npm run dev`.
3. No Gateway: `npm run dev`.
4. No web: `npm run dev`.

O Gateway fora da Vercel inicia o worker automaticamente e imprime
`[ia-worker] Processamento assíncrono ativo.`. Não é preciso outro terminal
com loop de curl, nem flag para ativar a fila. A migration 0002 precisa estar
aplicada; em bancos existentes, use `npm run db:migrate`, nunca `db:reset`
para habilitar a fila. Esta alteração não adiciona migration e não apaga análises.

## Produção

- Host persistente (Node/Express): o mesmo Gateway inicia seu worker.
- Vercel: configure um cron externo para enviar POST a
  `/api/internal/worker/tick`, com header `x-worker-token`.
- `WORKER_TICK_TOKEN` deve ser definido no Gateway e no cron. Em produção/Vercel,
  um token não configurado **recusa** o tick. Localmente ele pode ficar vazio.
- Não há loop de background dentro da função serverless. Sem cron, os jobs ficam
  na fila; o deploy do código não configura esse serviço externo automaticamente.

## Configurações operacionais (não selecionam modo síncrono/assíncrono)

| Variável | Papel |
|---|---|
| `IA_WORKER_BATCHES_PER_TICK` | Limite de passos por tick, padrão 1; cada passo faz no máximo uma chamada ao ia-analyze |
| `IA_MAX_FEEDBACKS_PER_BATCH` | Feedbacks por chamada de IA, padrão 20 |
| `IA_RPM_LIMIT` / `IA_RPD_LIMIT` | Reservas por minuto/dia e por empresa; zero/ausente não limita |
| `IA_ANALYZE_REMOTE_TIMEOUT_MS` | Timeout Gateway → ia-analyze, inclusive leitura da resposta |
| `WORKER_TICK_TOKEN` | Autorização do endpoint interno do worker |

## Fluxo durável

- O botão unificado envia `regenerate-insights` com `analyze_pending: true`.
  O próprio worker faz análise → insights parciais por lote → síntese final,
  mantendo empresa/escopo/item do job.
- O snapshot e o cursor ficam em `ia_analysis_job.options.checkpoint`.
  Pendentes que chegam depois do snapshot ficam para outra execução.
- Análises são salvas por lote. Uma retomada consulta os IDs já persistidos
  antes de chamar a IA, inclusive se houve crash entre INSERT e checkpoint.
- Relatórios usam todos os analisados do escopo (sem o corte legado em 100),
  em lotes. Os insights parciais são acumulados no checkpoint e enviados a uma
  API exclusiva de síntese. O reduce cria um único resumo em pt-BR e consolida
  recomendações semanticamente equivalentes antes da publicação.
- A síntese final é um passo separado e checkpointado. Se ela falhar, o worker
  retoma somente o reduce; os lotes anteriores não são enviados novamente.
- Cache considera a data das análises, não apenas a data de coleta. O relatório
  usa a data do snapshot para não esconder análises que chegaram durante a execução.
- Cada claim usa `SKIP LOCKED`, incrementa uma revisão de posse e ganha lease
  de 10 minutos. Heartbeat a cada 30 segundos renova a posse. Um running abandonado
  pode ser retomado após expirar; worker antigo não pode gravar checkpoint/status.
- Falhas transitórias reconhecidas recebem até 3 tentativas por passo, com espera
  e preservação do último checkpoint. Falhas definitivas ficam em `failed`.
  Uma nova submissão após falha definitiva cria novo job; lotes de análise já
  salvos são pulados, mas a síntese pode precisar ser refeita.
- O frontend recupera IDs por empresa no navegador e consulta
  `GET /api/protected/ia-analyze/jobs` para recuperar trabalhos ativos.
  Fechar o modal, mudar de página ou fechar a aba não interrompe o servidor.
  Falha de conexão no polling gera reconexão, não falha artificial do job.

## Limites e verificação

Assíncrono elimina a espera longa da requisição do usuário; não elimina falhas
do provedor nem o limite de duração do host do worker/ia-analyze. Ajuste o tamanho
dos lotes ao runtime. Retentativas internas do provedor também consomem cota.

Os testes simulam IA/banco: seis lotes para 105 analisados, retomada de 102
pendentes, falha parcial, lease, cache, navegação e recuperação após reload.
Validar em produção exige observar o cron e as chamadas reais do provedor.
