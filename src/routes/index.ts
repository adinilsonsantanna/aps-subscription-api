import { Router } from "express";
import installRoutes from "./install.routes";

const router = Router();

router.get("/", (_, res) => {
    res.json({
        status: "OK",
    });
});

router.use("/api/shop", installRoutes);

export default router;