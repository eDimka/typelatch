import type { NoticeRecord } from "./types.js";
export const noticeCaption = (notice: NoticeRecord): string => `${notice.kind}: ${notice.window.from} to ${notice.window.to}`;
