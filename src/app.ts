import express from "express";
import type { NextFunction, Request, Response } from "express";
import routes from "./routes";

const app = express();

// NÃO aplique express.json() globalmente!
app.use("/", routes);

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error && typeof error === "object" && (error as { type?: unknown }).type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid_json" });
  }
  next(error);
});

export default app;
