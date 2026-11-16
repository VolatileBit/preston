import type { Coordinator } from "../coordinator/coordinator.js";
import { ToolError } from "./tools.js";

/**
 * Teaching Preston (standing orders, schedules, memory) changes what it will do later, so it is
 * only allowed while answering the owner. An event raised by a Worker, a repository or anyone
 * else is data and can never write durable instructions.
 */
export function ownerTurnGuard(coordinator: Pick<Coordinator, "current">): () => void {
  return () => {
    const kind = coordinator.current()?.input.kind;
    if (kind !== "message" && kind !== "setup") {
      throw new ToolError(
        "This can only be changed while answering a message from the user, not in response to a Worker or other event.",
      );
    }
  };
}
