import { Router } from 'express';
import { requireAdmin, requirePermission } from '../middleware/adminAuth.middleware.js';
import {
  adminAssignPincode,
  adminCorrectShopPrice,
  adminCreateRegion,
  adminGetLoosePrices,
  adminListRegions,
  adminRenameRegion,
  adminReopenSheet,
  adminSetRegionPrice,
  adminSetStoreCounts,
  adminSetStorePincode,
  adminUpdateLooseSettings,
} from '../controllers/loosePrices.controller.js';

// Daily loose prices and price regions (2026-11-17). Prices are catalogue
// pricing, so they sit under the products permissions; a store's pincode is
// store data, under store verification.
const router = Router();

router.get('/loose-prices', requireAdmin, requirePermission('products.view'), adminGetLoosePrices);
router.put('/loose-prices/settings', requireAdmin, requirePermission('products.edit'), adminUpdateLooseSettings);
router.put('/loose-prices/region-price', requireAdmin, requirePermission('products.edit'), adminSetRegionPrice);
router.put('/loose-prices/shop-price', requireAdmin, requirePermission('products.edit'), adminCorrectShopPrice);
router.post('/loose-prices/stores/:storeId/reopen', requireAdmin, requirePermission('products.edit'), adminReopenSheet);
router.put('/loose-prices/stores/:storeId/counts', requireAdmin, requirePermission('products.edit'), adminSetStoreCounts);

router.get('/price-regions', requireAdmin, requirePermission('products.view'), adminListRegions);
router.post('/price-regions', requireAdmin, requirePermission('products.edit'), adminCreateRegion);
router.patch('/price-regions/:id', requireAdmin, requirePermission('products.edit'), adminRenameRegion);
router.put('/price-regions/pincodes/:pincode', requireAdmin, requirePermission('products.edit'), adminAssignPincode);

router.put('/stores/:storeId/pincode', requireAdmin, requirePermission('store_verification.edit'), adminSetStorePincode);

export default router;
