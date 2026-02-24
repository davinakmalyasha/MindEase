import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function check() {
    const users = await prisma.user.findMany({
        select: { id: true, email: true, role: true, name: true }
    });
    console.log("=== USER ROLES IN DB ===");
    console.table(users);
}

check().then(() => prisma.$disconnect());
