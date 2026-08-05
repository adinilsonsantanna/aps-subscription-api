import app from "./app";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`APS Subscription API rodando na porta ${PORT}`);
});