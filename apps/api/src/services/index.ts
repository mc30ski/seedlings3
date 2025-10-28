import type { Services } from "../types/services";

import { equipment } from "./equipment";
import { users } from "./users";
import { currentUser } from "./currentUser";
import { activity } from "./activity";
import { audit } from "./audit";
import { clients } from "./clients";

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error("Missing CLERK_SECRET_KEY for server-side Clerk client");
}

export const services: Services = {
  equipment,
  users,
  currentUser,
  activity,
  audit,
  clients,
};
