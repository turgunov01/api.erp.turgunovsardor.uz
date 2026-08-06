-- AlterTable
ALTER TABLE "CashTransaction" ADD COLUMN     "reconciled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reconciledAt" TIMESTAMP(3),
ADD COLUMN     "statementRef" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "vatEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vatRatePct" INTEGER NOT NULL DEFAULT 12;

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodCode" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "plannedMinor" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "counterparty" TEXT,
    "category" TEXT NOT NULL DEFAULT 'other',
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "accountId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "paidTxId" TEXT,
    "paidAt" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Budget_tenantId_periodCode_idx" ON "Budget"("tenantId", "periodCode");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_tenantId_periodCode_accountCode_key" ON "Budget"("tenantId", "periodCode", "accountCode");

-- CreateIndex
CREATE INDEX "PaymentSchedule_tenantId_dueDate_idx" ON "PaymentSchedule"("tenantId", "dueDate");

-- CreateIndex
CREATE INDEX "PaymentSchedule_tenantId_status_idx" ON "PaymentSchedule"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSchedule" ADD CONSTRAINT "PaymentSchedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
