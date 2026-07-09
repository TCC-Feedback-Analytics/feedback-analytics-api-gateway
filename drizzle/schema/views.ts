// Schema Drizzle — Views (enterprise_public).
import { pgView, uuid, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const enterprisePublic = pgView("enterprise_public", {	id: uuid(),
	name: text(),
}).as(sql`SELECT e.id, pu.name AS name FROM enterprise e LEFT JOIN "user" pu ON pu.id = e.auth_user_id`);
