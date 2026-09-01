-- The Meta phone_number_id of the WhatsApp Business number that RECEIVES this
-- practice's client messages (#79's promised column). Additive: nullable, no
-- backfill — an unset practice keeps resolving through WHATSAPP_PRACTICE_MAP,
-- and the worker's resolver simply finds nothing. UNIQUE because one Meta
-- number delivers to exactly one practice.
ALTER TABLE "practices" ADD COLUMN "whatsapp_phone_number_id" TEXT;

CREATE UNIQUE INDEX "practices_whatsapp_phone_number_id_key"
  ON "practices" ("whatsapp_phone_number_id");
