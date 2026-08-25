export function canonicalizeShopId(shopId: string): string {
    // 1. Numeric legacy: /^[1-9]\d*$/
    // 2. GID: /^gid:\/\/shopify\/Shop\/([1-9]\d*)$/
    
    const numericRegex = /^[1-9]\d*$/;
    const gidRegex = /^gid:\/\/shopify\/Shop\/([1-9]\d*)$/;
    
    if (numericRegex.test(shopId)) {
        return `gid://shopify/Shop/${shopId}`;
    }
    
    const gidMatch = shopId.match(gidRegex);
    if (gidMatch) {
        return `gid://shopify/Shop/${gidMatch[1]}`;
    }
    
    throw new Error(`Invalid shopId format: ${shopId}`);
}
