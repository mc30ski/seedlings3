import fp from "fastify-plugin";
import { Prisma } from "@prisma/client";

// Fastify plugin that installs a global error handler.
// It normalizes errors into clean JSON responses, maps common Prisma errors to friendly HTTP status codes, and falls back to a 500 with logging.

export default fp(async (app) => {
  app.setErrorHandler((err, _req, reply) => {
    const anyErr = err as any;

    // 1) Respect Fastify/fastify-sensible httpErrors
    if (typeof anyErr?.statusCode === "number") {
      return reply.code(anyErr.statusCode).send({
        code: anyErr.code || "HTTP_ERROR",
        message: err.message,
        details: anyErr.details ?? undefined,
      });
    }

    // 2) Our ServiceError (code + statusCode)
    if (typeof anyErr?.statusCode === "number" && anyErr?.code) {
      return reply.code(anyErr.statusCode).send({
        code: anyErr.code,
        message: anyErr.message,
        details: anyErr.details ?? undefined,
      });
    }

    // 3) Prisma known errors → friendly status codes
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      switch (err.code) {
        case "P2002":
          return reply
            .code(409)
            .send({ code: "UNIQUE_VIOLATION", message: err.message });
        case "P2025":
          return reply
            .code(404)
            .send({ code: "NOT_FOUND", message: err.message });
      }
    }

    // 4) Fallback — include real error info in the response so
    //    intermittent 500s are actually debuggable. This app is
    //    internal-only (staff and specific client contacts, all
    //    authenticated) so leaking error details is worth the
    //    debuggability. If it ever goes fully public, gate `detail`
    //    behind a NODE_ENV === "production" check that returns the
    //    generic message.
    app.log.error({ err }, "unhandled error");
    const detail =
      anyErr?.message ?? (typeof anyErr === "string" ? anyErr : String(anyErr));
    // Prisma errors carry structured info that helps localize the
    // failure — surface both the code and any meta.target (which
    // column/index/relation triggered it).
    let prismaCode: string | undefined;
    let prismaMeta: unknown;
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      prismaCode = err.code;
      prismaMeta = err.meta;
    } else if (err instanceof Prisma.PrismaClientValidationError) {
      prismaCode = "PRISMA_VALIDATION";
    } else if (err instanceof Prisma.PrismaClientInitializationError) {
      prismaCode = "PRISMA_INIT";
    } else if (err instanceof Prisma.PrismaClientRustPanicError) {
      prismaCode = "PRISMA_PANIC";
    }
    return reply.code(500).send({
      code: "INTERNAL",
      message: "Internal Server Error",
      // Human-readable message the operator can act on / paste back.
      detail,
      // Structured breadcrumbs for pattern-matching intermittent
      // failures across requests.
      errorName: anyErr?.name ?? undefined,
      prismaCode,
      prismaMeta,
    });
  });
});
