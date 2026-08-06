-- CreateTable
CREATE TABLE "Tender" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "organization" TEXT,
    "amountMinor" BIGINT,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "category" TEXT,
    "region" TEXT,
    "deadline" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tender_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tender_tenantId_deadline_idx" ON "Tender"("tenantId", "deadline");

-- CreateIndex
CREATE INDEX "Tender_tenantId_source_idx" ON "Tender"("tenantId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "Tender_tenantId_source_externalId_key" ON "Tender"("tenantId", "source", "externalId");

-- AddForeignKey
ALTER TABLE "Tender" ADD CONSTRAINT "Tender_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
