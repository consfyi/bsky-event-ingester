import type { PostView } from "@atcute/bluesky/types/app/feed/defs";
import type { ResourceUri } from "@atcute/lexicons";
import {
  configureOAuth,
  deleteStoredSession,
  finalizeAuthorization,
  getSession,
  listStoredSessions,
  Session,
} from "@atcute/oauth-browser-client";
import { parse as parseDate } from "date-fns";
import { sortBy } from "lodash-es";
import { useMemo } from "react";
import useSWR, { SWRConfiguration, SWRResponse } from "swr";
import { LABELER_DID } from "~/config";
import clientMetadata from "../public/client-metadata.json";
import { Client } from "./bluesky";

export function hookifyPromise<T>(promise: Promise<T>) {
  let status: "pending" | "success" | "error" = "pending";
  let result: T;

  const suspender = promise.then(
    (r) => {
      status = "success";
      result = r;
    },
    (e) => {
      status = "error";
      result = e;
    }
  );

  return () => {
    if (status === "pending") {
      throw suspender;
    } else if (status === "error") {
      throw result;
    } else {
      return result;
    }
  };
}

export const useClient = hookifyPromise(
  (async () => {
    if (typeof window == "undefined") {
      return new Client();
    }

    const params = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search
    );

    configureOAuth({
      metadata: {
        client_id: clientMetadata.client_id,
        redirect_uri: clientMetadata.redirect_uris[0],
      },
    });

    let session: Session | null = null;
    if (params.size > 0) {
      try {
        session = await finalizeAuthorization(params);
      } catch (e) {
        // Do nothing.
      }
    } else {
      const sessions = listStoredSessions();
      if (sessions.length > 0) {
        const did = sessions[0];
        try {
          session = await getSession(did, { allowStale: false });
        } catch (e) {
          deleteStoredSession(did);
        }
      }
    }

    return new Client(session);
  })()
);

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
    opts
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
    opts
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
