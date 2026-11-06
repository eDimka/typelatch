import type { DeliveryState } from "./types.js";
import type { DeliveryWindow } from "../shared/types.js";
import { copyState } from "./copy.js";
import { reschedule } from "./reschedule.js";
export class DeliveryBook {
  private readonly state: DeliveryState;
  constructor(initial: DeliveryState) { this.state = copyState(initial); }
  reschedule(orderId: string, window: DeliveryWindow): boolean { return reschedule(this.state, orderId, window); }
  snapshot(): DeliveryState { return copyState(this.state); }
}
