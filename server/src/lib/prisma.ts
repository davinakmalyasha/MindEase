import { PrismaClient } from "@prisma/client";

/**
 * Shared PrismaClient singleton. All modules import this instead of creating
 * their own instance, avoiding N connection pools per process.
 */
export const prisma = new PrismaClient();
