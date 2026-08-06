-- CreateTable
CREATE TABLE "MrpRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "includeMinStock" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "requestId" TEXT,
    "requestNumber" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MrpRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MrpLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productSku" TEXT,
    "demandQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "minTopUpQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "onHandQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "onOrderQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "netQty" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "suggestedQty" DECIMAL(65,30) NOT NULL DEFAULT 0,

    CONSTRAINT "MrpLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MrpRun_tenantId_idx" ON "MrpRun"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "MrpRun_tenantId_number_key" ON "MrpRun"("tenantId", "number");

-- CreateIndex
CREATE INDEX "MrpLine_tenantId_idx" ON "MrpLine"("tenantId");

-- CreateIndex
CREATE INDEX "MrpLine_runId_idx" ON "MrpLine"("runId");

-- AddForeignKey
ALTER TABLE "MrpRun" ADD CONSTRAINT "MrpRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MrpLine" ADD CONSTRAINT "MrpLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MrpLine" ADD CONSTRAINT "MrpLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MrpRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
