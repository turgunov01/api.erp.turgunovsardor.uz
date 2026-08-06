-- DropIndex
DROP INDEX "CashTransaction_number_key";

-- DropIndex
DROP INDEX "JournalEntry_number_key";

-- CreateTable
CREATE TABLE "NumberSequence" (
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("tenantId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashTransaction_tenantId_number_key" ON "CashTransaction"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_tenantId_number_key" ON "JournalEntry"("tenantId", "number");

