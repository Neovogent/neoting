-- CreateEnum
CREATE TYPE "VaultExportState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationKind" ADD VALUE 'GOOGLE_DRIVE';
ALTER TYPE "IntegrationKind" ADD VALUE 'ONEDRIVE';

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "vault_addon" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "vault_exports" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "kind" "IntegrationKind" NOT NULL,
    "state" "VaultExportState" NOT NULL DEFAULT 'QUEUED',
    "document_count" INTEGER NOT NULL,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "folder_name" TEXT,
    "failure_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vault_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vault_exports_business_id_created_at_idx" ON "vault_exports"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "vault_exports_state_idx" ON "vault_exports"("state");

-- AddForeignKey
ALTER TABLE "vault_exports" ADD CONSTRAINT "vault_exports_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
