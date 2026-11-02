-- D52: the tax estimate add-on. Additive; written only by the Stripe webhook.
ALTER TABLE "businesses" ADD COLUMN "tax_estimate_addon" BOOLEAN NOT NULL DEFAULT false;
