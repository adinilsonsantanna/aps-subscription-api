// src/app.ts
import express from "express";
import routes from "./routes";

const app = express();

// ⚠️ ORDEM É CRÍTICA!
// Primeiro monta as rotas (o webhook do Stripe usa raw() internamente)
app.use("/", routes);

// Depois aplica JSON para o resto da API
// Isso NÃO afeta rotas que já foram definidas acima
app.use(express.json());

export default app;