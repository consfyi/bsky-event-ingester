import type { ActorIdentifier, Did, ResourceUri } from "@atcute/lexicons";
import { useDLE, useSuspense } from "@data-client/react";
import type { TZDate } from "@date-fns/tz";
import { TZDateMini } from "@date-fns/tz";
import { addDays, isAfter, parse as parseDate, set as setDate } from "date-fns";
import { comparing, sorted } from "iter-fns";
import { useEffect, useState, useSyncExternalStore } from "react";
import { LABELER_DID } from "~/config";
import { Client, createClient } from "./bluesky";
import { useGlobalMemo } from "./components/GlobalMemoContext";
import {
  Post,
  Profile,
  useGetAuthorPosts,
  useGetFollows,
  useGetLabelerView,
  useGetLabels,
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
  const posts = useGlobalMemo(
    "conPosts",
    () => {
      const postsMap: Record<string, Post> = {};
      for (const post of resp) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const [_did, _collection, rkey] = post
          .uri!.replace(/^at:\/\//, "")
          .split("/");
        postsMap[rkey] = post;
      }
      return postsMap;
    },
    [resp]
  );
  return posts;
}

export interface Geocoded {
  latLng: [number, number] | null;
  timezone: string | null;
}

export interface Con {
  identifier: string;
  slug: string;
  name: string;
  start: TZDate;
  end: TZDate;
  address: string;
  country: string;
  geocoded: Geocoded | null;
  postRkey: string;
  url: string;
}

export type ConWithPost = Con & { post: Post };

export function useCons() {
  const labelerView = useSuspense(useGetLabelerView(), { did: LABELER_DID });
  const now = useNow();

  const cons = useGlobalMemo(
    "cons",
    () => {
      const cons = labelerView.policies!.labelValueDefinitions!.flatMap(
        (def) => {
          const fullDef = def as typeof def & {
            fbl_eventInfo: {
              slug: string;
              date: string;
              address: string;
              country: string;
              geocoded: {
                latLng: [string, string] | null;
                timezone: string | null;
              } | null;
              url: string;
            };
            fbl_postRkey: string;
          };

          const [strings] = def.locales;
          const [start, end] = fullDef.fbl_eventInfo.date.split("/");

          const refDate = new TZDateMini(
            new Date(),
            fullDef.fbl_eventInfo.geocoded?.timezone ?? "UTC"
          );

          const endDate = addDays(
            setDate<TZDate, TZDate>(
              parseDate<TZDate, TZDate>(end, "yyyy-MM-dd", refDate),
              {
                hours: 12,
                minutes: 0,
                seconds: 0,
                milliseconds: 0,
              }
            ),
            1
          );
          if (isAfter(now, endDate)) {
            return [];
          }

          const startDate = setDate(
            parseDate<TZDate, TZDate>(start, "yyyy-MM-dd", refDate),
            { hours: 12, minutes: 0, seconds: 0, milliseconds: 0 }
          );

          return [
            {
              identifier: def.identifier,
              slug: fullDef.fbl_eventInfo.slug,
              name: strings.name,
              start: startDate,
              end: endDate,
              address: fullDef.fbl_eventInfo.address,
              country: fullDef.fbl_eventInfo.country,
              geocoded:
                fullDef.fbl_eventInfo.geocoded != null
                  ? {
                      timezone: fullDef.fbl_eventInfo.geocoded.timezone,
                      latLng:
                        fullDef.fbl_eventInfo.geocoded.latLng != null
                          ? (fullDef.fbl_eventInfo.geocoded.latLng.map((v) =>
                              parseFloat(v)
                            ) as [number, number])
                          : null,
                    }
                  : null,
              postRkey: fullDef.fbl_postRkey,
              url: fullDef.fbl_eventInfo.url,
            } satisfies Con,
          ];
        }
      );

      return cons;
    },
    [labelerView, now]
  );
  return cons;
}

export function useConsWithPosts() {
  const cons = useCons();
  const conPosts = useConPosts();

  return cons.flatMap((con) =>
    Object.prototype.hasOwnProperty.call(conPosts, con.postRkey)
      ? [{ ...con, post: conPosts[con.postRkey] }]
      : []
  );
}

export function useLikes(uri: ResourceUri) {
  return useSuspense(useGetLikes(), { uri });
}

export function useSelf() {
  const client = useClient();
  const resp = useSuspense(
    useGetProfile(),
    client.did != null ? { actor: client.did } : null
  );
  return resp;
}

export function useProfile(actor: ActorIdentifier | undefined) {
  const resp = useSuspense(useGetProfile(), actor != null ? { actor } : null);
  return resp;
}

export function useProfileLabels(did: Did | undefined) {
  const resp = useSuspense(useGetLabels(), did != null ? { did } : null);
  return resp?.labels;
}

export function useSelfFollowsDLE() {
  const client = useClient();
  const { data, loading, error } = useDLE(
    useGetFollows(),
    client.did != null ? { actor: client.did } : null
  );

  const follows = useGlobalMemo(
    "selfFollows",
    () => {
      if (data == null) {
        return null;
      }
      const follows = new Set<string>();
      for (const follow of data) {
        follows.add(follow.did!);
      }
      return follows;
    },
    [data]
  );

  return { data: follows, loading, error };
}

function useFollowedConAttendeesGlobalMemo(data: Profile[] | undefined) {
  return useGlobalMemo(
    "followedConAttendees",
    () => {
      if (data == null) {
        return null;
      }
      const cons: Record<string, Profile[]> = {};
      for (const follow of data) {
        for (const label of follow.labels!) {
          if (label.src != LABELER_DID) {
            continue;
          }
          cons[label.val] = [...(cons[label.val] ?? []), follow];
        }
      }
      for (const k in cons) {
        cons[k] = sorted(
          cons[k],
          comparing((v) => v.handle)
        );
      }
      return cons;
    },
    [data]
  );
}

export function useFollowedConAttendees() {
  const client = useClient();
  const data = useSuspense(
    useGetFollows(),
    client.did != null ? { actor: client.did } : null
  );
  return useFollowedConAttendeesGlobalMemo(data);
}

export function useFollowedConAttendeesDLE() {
  const client = useClient();
  const { data, loading, error } = useDLE(
    useGetFollows(),
    client.did != null ? { actor: client.did } : null
  );
  return { data: useFollowedConAttendeesGlobalMemo(data), loading, error };
}

export function useIsLoggedIn() {
  const client = useClient();
  return client.did != null;
}

export function useNow(interval: number = Infinity) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const handle =
      interval != Infinity
        ? setInterval(() => {
            setNow(new Date());
          }, interval)
        : null;
    return () => {
      if (handle != null) {
        clearInterval(handle);
      }
    };
  }, [interval, setNow]);
  return now;
}
