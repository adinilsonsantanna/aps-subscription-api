import { Request, Response } from "express";
import { ShopService } from "../services/ShopService";

export class InstallController {
    private shopService = new ShopService();

    async install(req: Request, res: Response) {
        try {
            const {
                shopifyShopId,
                name,
                domain,
                accessToken,
                scopes,
            } = req.body;

            const shop = await this.shopService.installShop({
                shopifyShopId,
                name,
                domain,
                accessToken,
                scopes,
            });

            return res.status(200).json(shop);
        } catch (error) {
            console.error(error);

            return res.status(500).json({
                error: "Erro ao salvar loja",
            });
        }
    }
}