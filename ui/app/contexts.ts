import { createContext } from "react";
import { Client } from "./bluesky";

export const ClientContext = createContext(null as Client | null);
