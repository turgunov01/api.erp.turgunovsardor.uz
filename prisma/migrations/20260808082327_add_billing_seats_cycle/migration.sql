-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "cycle" TEXT NOT NULL DEFAULT 'monthly',
ADD COLUMN     "seats" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
ADD COLUMN     "extraSeats" INTEGER NOT NULL DEFAULT 0;
