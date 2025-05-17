import { sortBy } from "lodash-es";
import { useContext } from "react";
import useSWR, { SWRConfiguration, SWRResponse } from "swr";
import { LABELER_DID } from "~/config";

import { parse as parseDate } from "date-fns";
import type { Did, ResourceUri } from "@atcute/lexicons";
import type { PostView } from "@atcute/bluesky/types/app/feed/defs";
import { ClientContext } from "./context";
import type { ProfileViewDetailed } from "@atcute/bluesky/types/app/actor/defs";

export function useClient() {
  return useContext(ClientContext);
}

export function useThread(uri: ResourceUri | null, opts?: SWRConfiguration) {
  const client = useClient()!;

  const { data, error, isLoading } = useSWR(
    uri != null ? ["thread", uri] : null,
    () => client.getPostThread(uri!),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      ...opts,
    }
  );

  return { data, error, isLoading };
}

export function useConPosts(opts?: SWRConfiguration) {
  const client = useClient()!;

  const { data, error, isLoading } = useSWR(
    ["conPosts"],
    async () => {
      const posts = new Map<string, PostView>();
      for await (const postView of client.getAuthorPosts(LABELER_DID)) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const [_did, _collection, rkey] = postView.uri
          .replace(/^at:\/\//, "")
          .split("/");
        posts.set(rkey, postView);
      }
      return posts;
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      ...opts,
    }
  );

  return { data, error, isLoading };
}

export interface Con {
  identifier: string;
  name: string;
  start: Date;
  end: Date;
  location: string;
  rkey: string;
  url: string;
}

export function useCons(opts?: SWRConfiguration): SWRResponse<Con[] | null> {
  const client = useClient()!;

  return useSWR(
    ["labelerView"],
    async () => {
      const data = await client.getLabelerView(LABELER_DID);
      if (data == null) {
        return null;
      }

      const cons = data.policies!.labelValueDefinitions!.map((def) => {
        const fullDef = def as typeof def & {
          fbl_eventInfo: { date: string; location: string; url: string };
          fbl_postRkey: string;
        };

        const [strings] = def.locales;
        const [start, end] = fullDef.fbl_eventInfo.date.split("/");
        return {
          identifier: def.identifier,
          name: strings.name,
          start: parseDate(start, "yyyy-MM-dd", new Date()),
          end: parseDate(end, "yyyy-MM-dd", new Date()),
          location: fullDef.fbl_eventInfo.location,
          rkey: fullDef.fbl_postRkey,
          url: fullDef.fbl_eventInfo.url,
        };
      });

      return sortBy(cons, (con) => con.start);
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      ...opts,
    }
  );
}

export function useLikes(uri: ResourceUri | null, opts?: SWRConfiguration) {
  const client = useClient()!;

  return useSWR(
    uri != null ? ["likes", uri] : null,
    async () => {
      const likes = [];
      for await (const like of client.getLikes(uri!)) {
        likes.push(like);
      }
      return likes;
    },
    { revalidateOnFocus: false, revalidateOnReconnect: false, ...opts }
  );
}

export function useLabels(did: Did | null, opts?: SWRConfiguration) {
  const client = useClient()!;

  return useSWR(
    did != null ? ["labels", did] : null,
    async () => {
      const labels = new Set();
      for await (const label of client.getLabels(did!)) {
        labels.add(label);
      }
      return labels;
    },
    { revalidateOnFocus: false, revalidateOnReconnect: false, ...opts }
  );
}

export interface UserView {
  profile: ProfileViewDetailed;
  follows: Set<string>;
}

export function useUserView(opts?: SWRConfiguration) {
  const client = useClient()!;

  return useSWR(
    client.did != null ? ["userView"] : null,
    async () => {
      const [profile, follows] = await Promise.all([
        client.getProfile(client.did!),
        (async () => {
          const follows = new Set<string>();
          for await (const follow of client.getFollows(client.did!)) {
            follows.add(follow.did);
          }
          return follows;
        })(),
      ]);
      return { profile, follows } as UserView;
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      ...opts,
    }
  );
}
