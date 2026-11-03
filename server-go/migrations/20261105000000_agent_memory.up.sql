-- Agent memory: long-term per-account notes with preview-first retrieval.
--
-- AiMemory stores patient-authored or agent-noted facts the support agent can
-- recall. The list endpoint returns only preview (140 chars) so the full
-- content is never injected into a prompt unless the agent explicitly fetches
-- it via memory_get. One row per fact, updated not deleted by the agent;
-- deletion is a user action. Consent (ai-read) gates memory_* tools, and every
-- tool call is audited like a clinical read.
CREATE TABLE `AiMemory` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `preview` VARCHAR(140) NOT NULL,
    `content` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AiMemory_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
