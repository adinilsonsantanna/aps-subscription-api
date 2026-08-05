import { Router } from "express";

const router = Router();

router.post("/", (req, res) => {
    res.sendStatus(200);
});

export default router;