import { randomUUID } from "node:crypto";
import { flue } from "@flue/runtime/routing";

export const INTERNAL_FLUE_HEADER = "x-nobo-internal-flue";
export const INTERNAL_FLUE_TOKEN = randomUUID();
export const flueApp = flue();
