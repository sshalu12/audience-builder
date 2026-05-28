import { Router } from "express";
import { MessageRole, Role } from "@prisma/client";
import { prisma } from "../db.js";
import { getAuthUser, requireAuth } from "../middleware/auth.js";
import {
  approveAudiencePlan,
  handlePlannerMessage,
  removeSignalFromPlan,
} from "../services/audienceAgent.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { HttpError } from "../utils/httpError.js";

export const conversationRouter = Router();

function paramString(value: string | string[] | undefined): string {
  if (value === undefined) {
    return "";
  }
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

conversationRouter.use(requireAuth);

async function assertConversationAccess(conversationId: string, user: { id: string; role: Role }) {
  const conversation = await prisma.conversation.findFirst({
    where: user.role === Role.ADMIN ? { id: conversationId } : { id: conversationId, userId: user.id },
  });

  if (!conversation) {
    throw new HttpError(404, "Conversation not found");
  }

  return conversation;
}

async function loadConversation(conversationId: string) {
  return prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      user: { select: { id: true, email: true, name: true, role: true } },
      messages: { orderBy: { createdAt: "asc" } },
      audiencePlan: true,
    },
  });
}

conversationRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = getAuthUser(req);
    const conversations = await prisma.conversation.findMany({
      where: user.role === Role.ADMIN ? {} : { userId: user.id },
      include: {
        audiencePlan: true,
        user: { select: { id: true, email: true, name: true, role: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: "desc" },
    });

    res.json({ conversations });
  })
);

conversationRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const user = getAuthUser(req);
    const { title } = req.body as { title?: string };

    const conversation = await prisma.conversation.create({
      data: {
        userId: user.id,
        title: title?.trim() || null,
      },
    });

    res.status(201).json({ conversation });
  })
);

conversationRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const user = getAuthUser(req);
    const conversationId = paramString(req.params.id);
    await assertConversationAccess(conversationId, user);
    const conversation = await loadConversation(conversationId);
    res.json({ conversation });
  })
);

conversationRouter.post(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const user = getAuthUser(req);
    const conversationId = paramString(req.params.id);
    await assertConversationAccess(conversationId, user);

    const content = String((req.body as { content?: string }).content ?? "").trim();
    if (!content) {
      throw new HttpError(400, "Message content is required");
    }

    await prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.USER,
        content,
      },
    });

    await handlePlannerMessage(conversationId, content);
    const conversation = await loadConversation(conversationId);
    res.json({ conversation });
  })
);

conversationRouter.post(
  "/:id/approve",
  asyncHandler(async (req, res) => {
    const user = getAuthUser(req);
    const conversationId = paramString(req.params.id);
    await assertConversationAccess(conversationId, user);
    const estimate = await approveAudiencePlan(conversationId, true);
    const conversation = await loadConversation(conversationId);
    res.json({ estimate, conversation });
  })
);

conversationRouter.post(
  "/:id/estimate",
  asyncHandler(async (req, res) => {
    const user = getAuthUser(req);
    const conversationId = paramString(req.params.id);
    await assertConversationAccess(conversationId, user);
    const estimate = await approveAudiencePlan(conversationId, false);
    const conversation = await loadConversation(conversationId);
    res.json({ estimate, conversation });
  })
);

conversationRouter.post(
  "/:id/signals/remove",
  asyncHandler(async (req, res) => {
    const user = getAuthUser(req);
    const conversationId = paramString(req.params.id);
    await assertConversationAccess(conversationId, user);
    const { signalId } = req.body as { signalId?: string };

    if (!signalId) {
      throw new HttpError(400, "signalId is required");
    }

    await removeSignalFromPlan(conversationId, signalId);
    const conversation = await loadConversation(conversationId);
    res.json({ conversation });
  })
);
