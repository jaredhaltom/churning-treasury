import { PrismaClient } from "@prisma/client";
import { IS_DEMO, DEMO_DB_URL, bootstrapDemoDb } from "@/lib/demo";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  if (IS_DEMO) {
    bootstrapDemoDb();
    return new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
      datasources: { db: { url: DEMO_DB_URL } },
    });
  }
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
