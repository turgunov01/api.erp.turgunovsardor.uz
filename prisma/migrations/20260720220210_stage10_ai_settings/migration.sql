-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "aiApiKeyEnc" TEXT,
ADD COLUMN     "aiModel" TEXT,
ADD COLUMN     "aiProvider" TEXT NOT NULL DEFAULT 'anthropic';
