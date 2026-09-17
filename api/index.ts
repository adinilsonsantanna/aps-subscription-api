import app from "../src/app";
import { SubscriptionGiftRecoveryController } from "../src/controllers/SubscriptionGiftRecoveryController";

// Handler explícito para garantir que rota allowlisted esteja presente no build Vercel.
const recoveryController = new SubscriptionGiftRecoveryController();
app.post("/api/cron/subscription-gifts/recover", recoveryController.run.bind(recoveryController));

// O @vercel/node detecta automaticamente apps Express
// e cria o handler serverless. Não precisamos de tipos customizados.
export default app;
