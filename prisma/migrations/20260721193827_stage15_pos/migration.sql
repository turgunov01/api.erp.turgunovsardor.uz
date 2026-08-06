-- CreateTable
CREATE TABLE "PosRegister" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "priceListId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosRegister_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosShift" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "registerId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openingFloatMinor" BIGINT NOT NULL DEFAULT 0,
    "cashSalesMinor" BIGINT NOT NULL DEFAULT 0,
    "cardSalesMinor" BIGINT NOT NULL DEFAULT 0,
    "totalSalesMinor" BIGINT NOT NULL DEFAULT 0,
    "refundsMinor" BIGINT NOT NULL DEFAULT 0,
    "receiptCount" INTEGER NOT NULL DEFAULT 0,
    "expectedCashMinor" BIGINT,
    "countedCashMinor" BIGINT,
    "cashVarianceMinor" BIGINT,
    "openedBy" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "PosShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "registerId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'sale',
    "status" TEXT NOT NULL DEFAULT 'completed',
    "refReceiptId" TEXT,
    "subtotalMinor" BIGINT NOT NULL DEFAULT 0,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "vatMinor" BIGINT NOT NULL DEFAULT 0,
    "totalMinor" BIGINT NOT NULL DEFAULT 0,
    "cogsMinor" BIGINT NOT NULL DEFAULT 0,
    "paymentMethod" TEXT NOT NULL DEFAULT 'cash',
    "cashMinor" BIGINT NOT NULL DEFAULT 0,
    "cardMinor" BIGINT NOT NULL DEFAULT 0,
    "tenderedMinor" BIGINT NOT NULL DEFAULT 0,
    "changeMinor" BIGINT NOT NULL DEFAULT 0,
    "customerId" TEXT,
    "cashierId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosReceiptItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "sku" TEXT,
    "qty" DECIMAL(65,30) NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL DEFAULT 0,
    "lineTotalMinor" BIGINT NOT NULL DEFAULT 0,
    "costMinor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "PosReceiptItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosRegister_tenantId_idx" ON "PosRegister"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PosRegister_tenantId_code_key" ON "PosRegister"("tenantId", "code");

-- CreateIndex
CREATE INDEX "PosShift_tenantId_registerId_status_idx" ON "PosShift"("tenantId", "registerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PosShift_tenantId_number_key" ON "PosShift"("tenantId", "number");

-- CreateIndex
CREATE INDEX "PosReceipt_shiftId_idx" ON "PosReceipt"("shiftId");

-- CreateIndex
CREATE INDEX "PosReceipt_tenantId_createdAt_idx" ON "PosReceipt"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PosReceipt_tenantId_number_key" ON "PosReceipt"("tenantId", "number");

-- CreateIndex
CREATE INDEX "PosReceiptItem_receiptId_idx" ON "PosReceiptItem"("receiptId");

-- AddForeignKey
ALTER TABLE "PosRegister" ADD CONSTRAINT "PosRegister_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosShift" ADD CONSTRAINT "PosShift_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosShift" ADD CONSTRAINT "PosShift_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "PosRegister"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosReceipt" ADD CONSTRAINT "PosReceipt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosReceipt" ADD CONSTRAINT "PosReceipt_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "PosShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosReceipt" ADD CONSTRAINT "PosReceipt_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "PosRegister"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosReceiptItem" ADD CONSTRAINT "PosReceiptItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosReceiptItem" ADD CONSTRAINT "PosReceiptItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "PosReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
