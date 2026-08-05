import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
    res.json({ message: "Billing Routes OK" });
});

export default router;