import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { searchTaxonomyFreeText } from "../services/taxonomy.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const taxonomyRouter = Router();

taxonomyRouter.use(requireAuth);

taxonomyRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const limit = Number(req.query.limit ?? 50);

    if (!q) {
      res.json({ signals: [] });
      return;
    }

    const signals = await searchTaxonomyFreeText(q, Math.min(Math.max(limit, 1), 100));
    res.json({ signals });
  })
);
