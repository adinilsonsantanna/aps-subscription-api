import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
    res.json({ message: "Subscriptions Routes OK" });
});

export default router;