export const hasAvailableUnits = (available: number, requested: number): boolean => Number.isInteger(requested) && requested > 0 && available >= requested;
