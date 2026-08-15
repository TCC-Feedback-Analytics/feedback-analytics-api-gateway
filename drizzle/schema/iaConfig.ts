// Schema Drizzle — Config de IA por empresa (BYO-key, etapa 04).
// 1:1 com enterprise. A chave do provedor é guardada CIFRADA (AES-256-GCM):
// ciphertext + iv + auth tag — nunca em texto puro. `key_hint` guarda só os
// últimos caracteres (não sensível) para a UI confirmar qual chave está salva.
// O trigger set_updated_at entra como SQL manual na migration 0003 (drizzle-kit
// não deriva triggers).
import { pgTable, foreignKey, uuid, text, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { enterprise } from "./enterprise.js";

export const enterpriseIaConfig = pgTable("enterprise_ia_config", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	enterpriseId: uuid("enterprise_id").notNull(),
	provider: text().default('openrouter').notNull(),
	model: text(),
	apiKeyCiphertext: text("api_key_ciphertext"),
	apiKeyIv: text("api_key_iv"),
	apiKeyAuthTag: text("api_key_auth_tag"),
	keyHint: text("key_hint"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	unique("enterprise_ia_config_enterprise_unique").on(table.enterpriseId),
	foreignKey({
			columns: [table.enterpriseId],
			foreignColumns: [enterprise.id],
			name: "enterprise_ia_config_enterprise_id_fkey"
		}).onDelete("cascade"),
	check("enterprise_ia_config_provider_check", sql`provider = ANY (ARRAY['gemini'::text, 'openrouter'::text])`),
]);
