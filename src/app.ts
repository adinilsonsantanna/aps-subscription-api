import express from "express";
import routes from "./routes";

const app = express();

// NÃO aplique express.json() globalmente!
app.use("/", routes);

export default app;