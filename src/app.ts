// src/app.ts
import express from "express";
import routes from "./routes";

const app = express();

// Middleware condicional: aplica JSON em TODAS as rotas EXCETO webhook do Stripe
app.use((req, res, next) => {
    if (req.path === "/api/webhooks/stripe") {
        return next(); // pula o JSON parser para webhook Stripe
    }
    express.json()(req, res, next);
});

app.use("/", routes);

export default app;