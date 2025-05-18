import { createContext } from "react";
import { Client } from "./bluesky";

export const ClientContext = createContext(null as Client | null);

export const LocalAttendingContext = createContext({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getIsAttending(id: string): boolean {
    return false;
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setIsAttending(id: string, value: boolean) {},
});
