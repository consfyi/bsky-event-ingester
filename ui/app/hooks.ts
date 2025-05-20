import type { PostView } from "@atcute/bluesky/types/app/feed/defs";
import type { ResourceUri } from "@atcute/lexicons";
import { parse as parseDate } from "date-fns";
import { sortBy } from "lodash-es";
import { useMemo, useSyncExternalStore } from "react";
import useSWR, { SWRConfiguration } from "swr";
import { LABELER_DID } from "~/config";
import { Client, createClient } from "./bluesky";

export function hookifyPromise<T>(promise: Promise<T>) {
  let status: "pending" | "success" | "error" = "pending";
  let result: T;
  let error: unknown;

  const suspender = promise.then(
    (r) => {
      status = "success";
      result = r;
    },
    (e) => {
      status = "error";
      error = e;
    }
  );

  return () => {
    if (status == "pending") {
      throw suspender;
    }
    if (status == "error") {
      throw error;
    }
    return result;
  };
}

export const useHydrated = (() => {
  const subscribe = () => () => {};
  return () =>
    useSyncExternalStore(
      subscribe,
      () => true,
      () => false
    );
})();

export const useClient = (() => {
  let useClientInternal: (() => Client) | null = null;
  return () => {
    if (useClientInternal == null) {
      useClientInternal = hookifyPromise(createClient());
    }
    return useClientInternal();
  };
})();

export function useConPosts(opts?: SWRConfiguration) {
  const client = useClient();

  return useSWR(
    ["conPosts"],
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
    opts
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

export function useCons(opts?: SWRConfiguration) {
  const client = useClient();

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
    opts
  );
}

export function useLikes(uri: ResourceUri | null, opts?: SWRConfiguration) {
  const client = useClient();

  return useSWR(
    uri != null ? ["likes", uri] : null,
    async () => {
      const likes = [];
      for await (const like of client.getLikes(uri!)) {
        likes.push(like);
      }
      return likes;
    },
    opts
  );
}

export function useSelf(opts?: SWRConfiguration) {
  const client = useClient();

  return useSWR(
    client.did != null ? ["self"] : null,
    async () => {
      return await client.getProfile(client.did!);
    },
    opts
  );
}

export function useSelfFollows(opts?: SWRConfiguration) {
  const client = useClient();

  const { data, ...rest } = useSWR(
    client.did != null ? ["selfFollows"] : null,
    async () => {
      const follows = [];
      for await (const follow of client.getFollows(client.did!)) {
        follows.push(follow);
      }
      return follows;
    },
    {
      revalidateIfStale: false,
      suspense: false,
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
