import type { NoticeRecord } from "./types.js";
export const noticesForOrder = (notices: NoticeRecord[], orderId: string): NoticeRecord[] => notices.filter(notice => notice.orderId === orderId);
