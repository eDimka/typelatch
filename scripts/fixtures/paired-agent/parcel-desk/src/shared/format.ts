export const formatMoney = (cents: number): string => (cents / 100).toFixed(2);
export const formatWeight = (grams: number): string => `${grams} g`;
