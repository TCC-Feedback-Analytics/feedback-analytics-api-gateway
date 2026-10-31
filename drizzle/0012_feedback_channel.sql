-- Canal de coleta de cada feedback (etapa 06): QR Code, link compartilhado, etiqueta NFC ou o teste do dono.
-- Null = sem a marca de canal (os feedbacks de antes desta etapa e QR Codes antigos).
ALTER TABLE "feedback" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_channel_check" CHECK ((channel IS NULL) OR (channel = ANY (ARRAY['QR'::text, 'LINK'::text, 'NFC'::text, 'TEST'::text])));