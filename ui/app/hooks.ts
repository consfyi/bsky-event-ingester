import type { ResourceUri } from "@atcute/lexicons";
import { useDLE, useSuspense } from "@data-client/react";
import { parse as parseDate } from "date-fns";
import { sortBy } from "lodash-es";
import { useMemo, useSyncExternalStore } from "react";
import { LABELER_DID } from "~/config";
import { Client, createClient } from "./bluesky";
import {
  Post,
  useGetAuthorPosts,
  useGetFollows,
  useGetLabelerView,
  useGetLikes,
  useGetProfile,
} from "./endpoints";

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

function useConPosts() {
  const resp = useSuspense(useGetAuthorPosts(), { actor: LABELER_DID });
  const posts = useMemo(() => {
    const postsMap: Record<string, Post> = {};
    for (const post of resp) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [_did, _collection, rkey] = post
        .uri!.replace(/^at:\/\//, "")
        .split("/");
      postsMap[rkey] = post;
    }
    return postsMap;
  }, [resp]);
  return posts;
}

export interface Geocoded {
  address: string;
  country: string;
  latLng: [number, number];
}

export interface Con {
  identifier: string;
  name: string;
  start: Date;
  end: Date;
  location: string;
  geocoded: Geocoded | null;
  post: Post;
  postRkey: string;
  url: string;
}

export function useCons() {
  const labelerView = useSuspense(useGetLabelerView(), { did: LABELER_DID });
  const conPosts = useConPosts();

  const cons = useMemo(() => {
    const cons = labelerView.policies!.labelValueDefinitions!.flatMap((def) => {
      const fullDef = def as typeof def & {
        fbl_eventInfo: {
          date: string;
          location: string;
          geocoded?: {
            address: string;
            country: string;
            latLng: string;
          } | null;
          url: string;
        };
        fbl_postRkey: string;
      };

      if (
        !Object.prototype.hasOwnProperty.call(conPosts, fullDef.fbl_postRkey)
      ) {
        return [];
      }

      const [strings] = def.locales;
      const [start, end] = fullDef.fbl_eventInfo.date.split("/");
      return [
        {
          identifier: def.identifier,
          name: strings.name,
          start: parseDate(start, "yyyy-MM-dd", new Date()),
          end: parseDate(end, "yyyy-MM-dd", new Date()),
          location: fullDef.fbl_eventInfo.location,
          geocoded:
            fullDef.fbl_eventInfo.geocoded != null
              ? {
                  address: fullDef.fbl_eventInfo.geocoded.address,
                  country: fullDef.fbl_eventInfo.geocoded.country,
                  latLng: fullDef.fbl_eventInfo.geocoded.latLng
                    .split(/,/)
                    .map((v) => parseFloat(v)) as [number, number],
                }
              : null,
          post: conPosts[fullDef.fbl_postRkey],
          postRkey: fullDef.fbl_postRkey,
          url: fullDef.fbl_eventInfo.url,
        } satisfies Con,
      ];
    });

    return sortBy(cons, (con) => con.start);
  }, [labelerView, conPosts]);
  return cons;
}

export function useLikes(uri: ResourceUri) {
  const resp = useSuspense(useGetLikes(), { uri });
  return resp;
}

export function useSelf() {
  const client = useClient();
  const resp = useSuspense(
    useGetProfile(),
    client.did != null ? { did: client.did } : null
  );
  return resp;
}

export function useSelfFollowsDLE() {
  const client = useClient();
  const { data, loading, error } = useDLE(
    useGetFollows(),
    client.did != null ? { actor: client.did } : null
  );

  const follows = useMemo(() => {
    if (data == null) {
      return null;
    }
    const follows = new Set<string>();
    for (const follow of data) {
      follows.add(follow.did!);
    }
    return follows;
  }, [data]);

  return { data: follows, loading, error };
}

export function useIsLoggedIn() {
  const client = useClient();
  return client.did != null;
}
