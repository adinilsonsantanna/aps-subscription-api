import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Shopify API OK",
  });
});

router.get("/install", (req, res) => {
  res.json({
    success: true,
    message: "Endpoint de instalação da Shopify",
  });
});

export default router;