import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
    res.json({ message: "Admin Routes OK" });
});

export default router;