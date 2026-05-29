import { Router } from "express";
import { ConversationStatus, Role, SignalSource } from "@prisma/client";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole(Role.ADMIN));

adminRouter.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        _count: { select: { conversations: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ users });
  })
);

adminRouter.get(
  "/conversations",
  asyncHandler(async (_req, res) => {
    const conversations = await prisma.conversation.findMany({
      where: { status: ConversationStatus.APPROVED },
      include: {
        user: { select: { id: true, email: true, name: true, role: true } },
        audiencePlan: true,
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: "desc" },
    });

    res.json({ conversations });
  })
);

adminRouter.get(
  "/taxonomy",
  asyncHandler(async (req, res) => {
    const requestedSource = typeof req.query.source === "string" ? req.query.source : undefined;
    const source = requestedSource && Object.values(SignalSource).includes(requestedSource as SignalSource)
      ? (requestedSource as SignalSource)
      : undefined;
    const take = Math.min(Number(req.query.take ?? 100), 500);

    const taxonomy = await prisma.taxonomySignal.findMany({
      where: source ? { source } : {},
      orderBy: [{ source: "asc" }, { name: "asc" }],
      take,
    });

    const counts = await prisma.taxonomySignal.groupBy({
      by: ["source"],
      _count: { source: true },
    });

    res.json({ taxonomy, counts });
  })
);
