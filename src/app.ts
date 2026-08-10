import express from "express";
import routes from "./routes";

const app = express();

// Stripe webhook precisa do body RAW, não JSON
app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));

// Resto da API usa JSON normal
app.use(express.json());

app.use("/", routes);

export default app;