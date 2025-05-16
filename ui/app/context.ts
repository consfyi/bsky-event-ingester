import React from "react";
import { Profile } from "./bluesky";

export interface UserView {
  profile: Profile;
  follows: Set<string>;
}

export const UserViewContext = React.createContext({
  userView: null as UserView | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setUserView: (userView: UserView | null) => {},
});
