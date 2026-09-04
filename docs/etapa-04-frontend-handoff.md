# Etapa 04 — Handoff para o Frontend (config de IA por empresa / BYO-key)

> **Para quem vai implementar o frontend.** O backend do "cada empresa usa a própria chave OpenRouter" já está pronto e testado no gateway. Falta a **tela no perfil** onde o gestor cola a chave OpenRouter e escolhe o modelo. Este doc tem o contrato dos endpoints, a UX e os arquivos a tocar.

---

## 1. O que já existe no backend

O gateway expõe **3 endpoints** para a empresa gerenciar a própria config OpenRouter. A chave é **cifrada** (AES-256-GCM) no banco; o GET **nunca** devolve a chave — só se existe, o provedor, o modelo e um "hint" (últimos 4 caracteres). Sem chave configurada, as análises respondem `ia_config_required` por padrão.

---

## 2. Contrato da API

Base: mesma de hoje (`/api/protected/...`, cookie httpOnly, `credentials: 'include'`).

### 2.1 Ler a config atual
`GET /api/protected/user/ia-config`
```json
{ "hasKey": true, "provider": "openrouter", "model": "openrouter/auto", "keyHint": "xyz9" }
```
- Sem config ainda: `{ "hasKey": false, "provider": null, "model": null, "keyHint": null }`.
- **A chave NUNCA vem aqui** — `keyHint` é só os últimos 4 caracteres, para a UI confirmar qual chave está salva.

### 2.2 Salvar/atualizar a config
`PUT /api/protected/user/ia-config`
- **Body:** `{ "provider": "openrouter", "model": "openrouter/auto", "apiKey": "sk-or-..." }`
  - `provider`: use **`"openrouter"`** (é o caso do BYO-key). `model` é opcional. `apiKey` é obrigatória.
- **`200`:** `{ "hasKey": true, "provider": "openrouter", "model": "openrouter/auto", "keyHint": "1234" }`
- **`400` `{ "error": "ia_config_invalid_key" }`** — a chave não passou na validação do OpenRouter (o backend testa em `/auth/key` antes de salvar).
- **`400` `{ "error": "invalid_payload" }`** — corpo inválido (ex.: sem `apiKey`).

### 2.3 Remover a config
`DELETE /api/protected/user/ia-config`
```json
{ "hasKey": false, "provider": null, "model": null, "keyHint": null }
```
Depois disso, as análises ficam indisponíveis até uma nova chave OpenRouter ser configurada. O frontend deve orientar o usuário quando receber `ia_config_required`.

---

## 3. A tela (o que construir)

Uma seção **"Configuração de IA"** no perfil/configurações do usuário. Comportamento:

- **Ao abrir:** `GET` → mostra um **badge de status** ("Chave configurada" verde / "Sem chave" amarelo) e, se houver, o **modelo atual** + o **hint** (ex.: `sk-or-…xyz9`). O campo da chave começa **vazio** (a chave nunca é pré-preenchida).
- **Campo da API key:** input **mascarado** (`type="password"`) com botão **mostrar/ocultar** — reaproveite o padrão que já existe nos campos de senha (`components/public/forms/fields/*/fieldPassword.tsx`).
- **Seleção de modelo:** um `select` com uma **lista curada** de ids do OpenRouter + uma opção **"Outro (personalizado)"** que abre um input livre:
  - `openrouter/auto` (roteamento automático — bom default)
  - `google/gemini-2.5-flash`
  - `anthropic/claude-3.5-sonnet`
  - `openai/gpt-4o-mini`
  - `deepseek/deepseek-chat`
- **Botão "Salvar":** `PUT` com `{ provider: "openrouter", model, apiKey }`. Em sucesso → badge "Configurada" + toast; em erro → toast com a mensagem (ver seção 5).
- **Botão "Remover chave":** `DELETE` → badge "Sem chave".
- **Link de ajuda:** um link para `https://openrouter.ai/keys` ("Pegar minha chave OpenRouter").

> O `provider` da tela é sempre **`openrouter`** — os modelos da lista são ids do OpenRouter (inclusive o `google/gemini-2.5-flash`, que roteia pro Gemini). Não precisa de um seletor de provedor.

---

## 4. Arquivos a criar/tocar (repo `feedback-analytics-web`)

Estrutura: `pages/`, `components/`, `layouts/` na **raiz**; `services/`, `routes/`, `lib/` em **`src/`**.

| Arquivo | Mudança |
|---|---|
| **[NOVO]** `src/services/serviceIaConfig.ts` | `getIaConfig()`, `updateIaConfig(payload)`, `deleteIaConfig()` usando os helpers de `src/lib/utils/http.ts` (`getJson`/`putJson`/`deleteJson`, que já injetam `credentials:'include'`). Molde: `src/services/serviceEnterprise.ts`. |
| **[NOVO]** `pages/user/edit/editIaSettings.tsx` | Wrapper fino (PageHeader + Card + form). Molde: `pages/user/edit/editCompanyData.tsx`. |
| **[NOVO]** `components/user/pages/profile/editIaSettings/formIaSettings.tsx` | O form: `useForm` + `zodResolver` (molde `components/user/pages/profile/editUser/forms/formEmailUser.tsx`) + `useFetcher`/`useToast`; campo de chave mascarado, select de modelo curado + custom, badge de status, botões Salvar/Remover, link para openrouter. |
| **[NOVO]** `src/routes/actions/actionIaSettings.ts` | Lê o `formData`, chama o service, retorna `ActionData` (`lib/interfaces/contracts/action-data.contract`). Molde: `src/routes/actions/actionCollectingData.ts`. |
| **[MODIFY]** `src/routes/user.tsx` | Registrar a rota (ex.: `path="edit/ia-settings"` com `action={ActionIaSettings}`). Molde: as rotas de `edit/*` já existentes. |
| **[MODIFY]** `src/lib/mock/menu.ts` | Adicionar o item "Configuração de IA" (nav é data-driven; só este arquivo muda). |

**Tipos:** defina o shape da config (`{ hasKey, provider, model, keyHint }`) e do payload localmente no web — **não** precisa mexer no pacote `@feedback/lib-shared`.

---

## 5. Mapeamento de erros

O `PUT` pode voltar erro tipado em `{ error }`. Mapeie para mensagens claras (padrão de toast via `useToast`):

| error | Mensagem sugerida |
|---|---|
| `ia_config_invalid_key` | "Chave inválida — confira a chave no OpenRouter e tente de novo." |
| `invalid_payload` | "Informe a chave da API." |
| `enterprise_not_found` | "Empresa não encontrada." (raro; sessão inconsistente) |
| 5xx / genérico | "Não foi possível salvar agora. Tente novamente." |

---

## 6. Como testar localmente

1. **Gateway** rodando (`npm run dev`) com **`IA_CONFIG_ENCRYPTION_KEY`** setada no `.env` do gateway (gere: `openssl rand -base64 32`). Sem ela, o `PUT` retorna 500.
2. Precisa de uma **chave OpenRouter real** para o `PUT` passar (o backend valida no `/auth/key`). Pegue em `https://openrouter.ai/keys`.
3. Fluxo: abrir a tela (GET → "Sem chave") → colar a chave + escolher modelo → Salvar (PUT → "Configurada", badge + hint) → recarregar (GET mantém provider/model/hint, campo da chave vazio) → Remover (DELETE → "Sem chave").
4. Erro: colar uma chave inválida (`sk-or-invalid`) → toast "Chave inválida".

---

## 7. Checklist de aceite

- [ ] A tela mostra o **status** (com/sem chave) e, se houver, **modelo + hint** ao abrir.
- [ ] Campo da chave é **mascarado** com mostrar/ocultar e **nunca** vem pré-preenchido.
- [ ] Salvar com chave válida → badge "Configurada"; chave inválida → toast de erro tratado.
- [ ] Select de modelo com a lista curada + opção "personalizado".
- [ ] Remover chave → volta para "Sem chave".
- [ ] Link para `https://openrouter.ai/keys`.
- [ ] Item "Configuração de IA" no menu.

---

### Referência rápida
- `GET  /api/protected/user/ia-config` → `{ hasKey, provider, model, keyHint }`
- `PUT  /api/protected/user/ia-config` `{ provider:"openrouter", model, apiKey }` → `{ hasKey:true, ... }` | `400 ia_config_invalid_key`
- `DELETE /api/protected/user/ia-config` → `{ hasKey:false, ... }`
- A chave **nunca** trafega no GET. Provider da tela = `openrouter`. Modelos = ids do OpenRouter.
