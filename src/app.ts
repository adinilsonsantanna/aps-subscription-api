// src/app.ts
import express from "express";
import routes from "./routes";

const app = express();

// ⚠️ IMPORTANTE: Stripe webhook precisa do body RAW
// Isso é tratado na própria rota em webhooks.routes.ts

// Resto da API usa JSON normal
app.use(express.json());

app.use("/", routes);

export default app;