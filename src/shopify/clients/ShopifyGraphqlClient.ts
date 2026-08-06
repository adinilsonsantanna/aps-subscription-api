export class ShopifyGraphqlClient {
    private apiVersion = "2025-10";

    async query(
        shop: string,
        accessToken: string,
        query: string,
        variables?: any
    ) {
        const response = await fetch(
            `https://${shop}/admin/api/${this.apiVersion}/graphql.json`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": accessToken,
                },
                body: JSON.stringify({
                    query,
                    variables,
                }),
            }
        );

        return response.json();
    }
}
