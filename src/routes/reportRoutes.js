import express from "express";
import { verifyToken } from "../middlewares/authMiddleware.js";
import {
  exportExpenseExcel,
  exportExpensePDF,
  exportTithesExcel,
  exportTithesPDF,
  getExpenseReport,
  getTithesReport,
  getCombinedReport,
  exportCombinedExcel,
  exportCombinedPDF,
} from "../controllers/reportController.js";
import { authorizeRoles } from "../middlewares/roleMiddleware.js";

const router = express.Router();

router.get("/tithes", verifyToken, getTithesReport);
router.get("/expense", verifyToken, getExpenseReport);
router.get("/tithes/export/excel", verifyToken, exportTithesExcel);
router.get("/tithes/export/pdf", verifyToken, exportTithesPDF);
router.get(
  "/expense/export/excel",
  verifyToken,
  authorizeRoles("admin", "auditor"),
  exportExpenseExcel,
);
router.get(
  "/expense/export/pdf",
  verifyToken,
  authorizeRoles("admin", "auditor"),
  exportExpensePDF,
);
router.get(
  "/combined",
  verifyToken,
  authorizeRoles("admin", "auditor"),
  getCombinedReport,
);
router.get(
  "/combined/export/excel",
  verifyToken,
  authorizeRoles("admin", "auditor"),
  exportCombinedExcel,
);
router.get(
  "/combined/export/pdf",
  verifyToken,
  authorizeRoles("admin", "auditor"),
  exportCombinedPDF,
);

export default router;
