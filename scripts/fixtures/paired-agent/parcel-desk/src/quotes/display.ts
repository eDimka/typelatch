import type { Quote } from "./types.js";
import { formatMoney } from "../shared/format.js";
export const quoteCaption = (quote: Quote): string => `Total ${formatMoney(quote.totalCents)}`;
