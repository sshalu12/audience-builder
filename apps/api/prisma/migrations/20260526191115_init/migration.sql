-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'PLANNER');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('DRAFT', 'APPROVED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AudienceStatus" AS ENUM ('DRAFT', 'APPROVED');

-- CreateEnum
CREATE TYPE "SignalSource" AS ENUM ('LOCATION', 'TRANSACTION', 'CONSUMER_GRAPH_FIELD', 'CONSUMER_GRAPH_VALUE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'PLANNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'DRAFT',
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudiencePlan" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "audienceName" TEXT,
    "summary" TEXT,
    "intent" JSONB,
    "selectedSignals" JSONB NOT NULL DEFAULT '[]',
    "estimatedMin" INTEGER,
    "estimatedMax" INTEGER,
    "confidence" DOUBLE PRECISION,
    "estimate" JSONB,
    "status" "AudienceStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudiencePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxonomySignal" (
    "id" TEXT NOT NULL,
    "source" "SignalSource" NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "path" TEXT,
    "level1" TEXT,
    "level2" TEXT,
    "level3" TEXT,
    "level4" TEXT,
    "fieldName" TEXT,
    "fieldValue" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxonomySignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Conversation_userId_idx" ON "Conversation"("userId");

-- CreateIndex
CREATE INDEX "Conversation_status_idx" ON "Conversation"("status");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE INDEX "Message_role_idx" ON "Message"("role");

-- CreateIndex
CREATE UNIQUE INDEX "AudiencePlan_conversationId_key" ON "AudiencePlan"("conversationId");

-- CreateIndex
CREATE INDEX "TaxonomySignal_source_idx" ON "TaxonomySignal"("source");

-- CreateIndex
CREATE INDEX "TaxonomySignal_name_idx" ON "TaxonomySignal"("name");

-- CreateIndex
CREATE INDEX "TaxonomySignal_fieldName_idx" ON "TaxonomySignal"("fieldName");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudiencePlan" ADD CONSTRAINT "AudiencePlan_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
