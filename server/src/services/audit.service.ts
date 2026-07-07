import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface AuditEntry {
    action: string;
    actorId?: number | null;
    targetType?: string | null;
    targetId?: number | null;
    meta?: Record<string, any> | null;
}

export class AuditService {
    static async log(entry: AuditEntry) {
        try {
            await prisma.auditLog.create({
                data: {
                    action: entry.action,
                    actorId: entry.actorId ?? null,
                    targetType: entry.targetType ?? null,
                    targetId: entry.targetId ?? null,
                    meta: entry.meta ? JSON.stringify(entry.meta) : null,
                },
            });
        } catch (error) {
            console.error("[Audit] Failed to write audit log:", error);
        }
    }

    static async getLogs(page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                include: { actor: { select: { id: true, name: true, email: true, role: true } } },
                orderBy: { createdAt: "desc" },
                skip,
                take: limit,
            }),
            prisma.auditLog.count(),
        ]);
        return { logs, total, page, limit, totalPages: Math.ceil(total / limit) };
    }
}
