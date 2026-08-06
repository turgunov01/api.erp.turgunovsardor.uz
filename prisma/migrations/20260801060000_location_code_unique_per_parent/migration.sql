-- Location codes are now unique per PARENT (siblings), not per warehouse.
-- DropIndex (the old parent index is superseded by the new composite unique)
DROP INDEX "WarehouseLocation_parentId_idx";

-- DropIndex (old warehouse-wide unique blocked R-01 existing in two zones)
DROP INDEX "WarehouseLocation_warehouseId_code_key";

-- CreateIndex (unique only among siblings under the same parent)
CREATE UNIQUE INDEX "WarehouseLocation_parentId_code_key" ON "WarehouseLocation"("parentId", "code");
