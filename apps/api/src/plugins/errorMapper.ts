import fp from "fastify-plugin";
import { Prisma } from "@prisma/client";

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

    // 4) Fallback
    app.log.error({ err }, "unhandled error");
    return reply
      .code(500)
      .send({ code: "INTERNAL", message: "Internal Server Error" });
  });
});
