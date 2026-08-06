-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "didoxId" TEXT,
ADD COLUMN     "didoxStatus" TEXT,
ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'bank_transfer',
ADD COLUMN     "number" TEXT NOT NULL,
ADD COLUMN     "paidBy" TEXT,
ADD COLUMN     "vatMinor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "billAccount" TEXT,
ADD COLUMN     "billAddress" TEXT,
ADD COLUMN     "billBank" TEXT,
ADD COLUMN     "billDirector" TEXT,
ADD COLUMN     "billInn" TEXT,
ADD COLUMN     "billLegalName" TEXT,
ADD COLUMN     "billMfo" TEXT,
ADD COLUMN     "billPhone" TEXT;

-- CreateTable
CREATE TABLE "PlatformConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "sellerName" TEXT NOT NULL DEFAULT 'TTR Inc.',
    "sellerInn" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "bank" TEXT NOT NULL DEFAULT '',
    "account" TEXT NOT NULL DEFAULT '',
    "mfo" TEXT NOT NULL DEFAULT '',
    "director" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "vatPercent" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");