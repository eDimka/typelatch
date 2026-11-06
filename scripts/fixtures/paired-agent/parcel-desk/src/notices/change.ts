import type { NoticeRecord } from "./types.js";
import type { DeliveryWindow } from "../shared/types.js";
import { copyWindow } from "../shared/copy.js";
export function changeNoticeWindow(notice: NoticeRecord, window: DeliveryWindow): void { notice.window = copyWindow(window); }
