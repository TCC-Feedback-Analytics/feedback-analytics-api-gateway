CREATE TABLE "auth_rate_limit" (
  "key" text PRIMARY KEY NOT NULL,
  "used" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_rate_limit_expiry_idx" ON "auth_rate_limit" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "auth_rate_limit" ENABLE ROW LEVEL SECURITY;
