// Relations — dispositivos rastreados.
import { relations } from "drizzle-orm/relations";
import { enterprise, trackedDevices } from "../schema.js";

export const trackedDevicesRelations = relations(trackedDevices, ({one}) => ({
	enterprise: one(enterprise, {
		fields: [trackedDevices.enterpriseId],
		references: [enterprise.id]
	}),
}));
