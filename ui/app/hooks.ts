import type { PostView } from "@atcute/bluesky/types/app/feed/defs";
import type { ResourceUri } from "@atcute/lexicons";
import { parse as parseDate } from "date-fns";
import { sortBy } from "lodash-es";
import { useContext, useMemo } from "react";
import useSWR, { SWRConfiguration, SWRResponse } from "swr";
import { LABELER_DID } from "~/config";
import { ClientContext } from "./contexts";

export function useClient() {
  return useContext(ClientContext)!;
}

export function useThread(uri: ResourceUri | null, opts?: SWRConfiguration) {
  const client = useClient();

  return useSWR(
    client != null && uri != null ? ["thread", uri] : null,
    () => client.getPostThread(uri!),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      ...opts,
    }
  );
}

export function useConPosts(opts?: SWRConfiguration) {
  const client = useClient();

  return useSWR(
    client != null ? ["conPosts"] : null,
    async () => {
      const posts: Record<string, PostView> = {};
      for await (const postView of client.getAuthorPosts(LABELER_DID)) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const [_did, _collection, rkey] = postView.uri
          .replace(/^at:\/\//, "")
          .split("/");
        posts[rkey] = postView;
      }
      return posts;
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      ...opts,
    }
  );
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
  const client = useClient();

  const { data, ...rest } = useSWR(
    client != null ? ["labelerView"] : null,
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

  return { data, ...rest };
}

export function useLikes(uri: ResourceUri | null, opts?: SWRConfiguration) {
  const client = useClient();

  return useSWR(
    client != null && uri != null ? ["likes", uri] : null,
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

export function useSelf(opts?: SWRConfiguration) {
  const client = useClient();

  return useSWR(
    client != null && client.did != null ? ["self"] : null,
    () => client.getProfile(client.did!),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      ...opts,
    }
  );
}

export function useSelfFollows(opts?: SWRConfiguration) {
  const client = useClient();

  const { data, ...rest } = useSWR(
    client != null && client.did != null ? ["selfFollows"] : null,
    async () => {
      const follows = [];
      for await (const follow of client.getFollows(client.did!)) {
        follows.push(follow);
      }
      return follows;
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
      ...opts,
    }
  );

  const follows = useMemo(() => {
    if (data == null) {
      return null;
    }
    const follows = new Set<string>();
    for (const follow of data) {
      follows.add(follow.did);
    }
    return follows;
  }, [data]);

  return { data: follows, ...rest };
}
