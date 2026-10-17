export const nowSeconds = () => Math.floor(Date.now() / 1000);

export const isoFromSeconds = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export const httpDate = (s: number) => new Date(s * 1000).toUTCString();
