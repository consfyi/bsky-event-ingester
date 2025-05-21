import type { ResourceUri } from "@atcute/lexicons";
import { useDLE, useSuspense } from "@rest-hooks/react";
import { parse as parseDate } from "date-fns";
import { sortBy } from "lodash-es";
import { useMemo, useSyncExternalStore } from "react";
import { LABELER_DID } from "~/config";
import { Client, createClient } from "./bluesky";
import {
  getAuthorPosts,
  getFollows,
  getLabelerView,
  getLikes,
  getProfile,
  LabelerView,
  Post,
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

function postprocessConPosts(posts: Post[]): Record<string, Post> {
  const postsMap: Record<string, Post> = {};
  for (const post of posts) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_did, _collection, rkey] = post.uri
      .replace(/^at:\/\//, "")
      .split("/");
    postsMap[rkey] = post;
  }
  return postsMap;
}

export function useConPosts() {
  const client = useClient();
  const resp = useSuspense(getAuthorPosts, { client, actor: LABELER_DID });
  const posts = useMemo(() => postprocessConPosts(resp), [resp]);
  return posts;
}

export function useConPostsDLE() {
  const client = useClient();
  const { data, loading, error } = useDLE(getAuthorPosts, {
    client,
    actor: LABELER_DID,
  });

  const posts = useMemo(
    () => (data != null ? postprocessConPosts(data) : null),
    [data]
  );

  return { data: posts, loading, error };
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

function postprocessCon(labelerView: LabelerView) {
  const cons = labelerView.policies!.labelValueDefinitions!.map((def) => {
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
}

export function useCons() {
  const client = useClient();
  const labelerView = useSuspense(getLabelerView, { client, did: LABELER_DID });
  const cons = useMemo(() => postprocessCon(labelerView), [labelerView]);
  return cons;
}

export function useConsDLE() {
  const client = useClient();
  const { data, loading, error } = useDLE(getLabelerView, {
    client,
    did: LABELER_DID,
  });
  const cons = useMemo(
    () => (data != null ? postprocessCon(data) : null),
    [data]
  );
  return { data: cons, loading, error };
}

export function useLikes(uri: ResourceUri) {
  const client = useClient();
  const resp = useSuspense(getLikes, { client, uri });
  return resp;
}

export function useSelf() {
  const client = useClient();

  const resp = useSuspense(
    getProfile,
    client.did != null ? { client, did: client.did } : null
  );
  return resp;
}

export function useSelfFollowsDLE() {
  const client = useClient();
  const { data, loading, error } = useDLE(
    getFollows,
    client.did != null ? { client, actor: client.did } : null
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

  return { data: follows, loading, error };
}
