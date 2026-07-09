// ─────────────────────────────────────────────────────────────────────────────
// FONTE ÚNICA DO SCHEMA (Drizzle) — barrel. As tabelas estão organizadas por
// domínio em drizzle/schema/*.ts e re-exportadas aqui. O drizzle-kit e o app
// (src/db/client.ts) importam deste arquivo. Ver ADR-0001 (Fase 2).
// ─────────────────────────────────────────────────────────────────────────────
export * from "./schema/auth.js";
export * from "./schema/enterprise.js";
export * from "./schema/questions.js";
export * from "./schema/feedback.js";
export * from "./schema/devices.js";
export * from "./schema/views.js";
