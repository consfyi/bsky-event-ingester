import { sortBy } from "lodash-es";
import { useContext, useMemo } from "react";
import useSWR, { SWRConfiguration } from "swr";
import { CLIENT } from "~/bluesky";
import { LABELER_DID } from "~/config";

import { parse as parseDate } from "date-fns";
import { UserViewContext } from "./context";

export function useCons(opts?: SWRConfiguration) {
  const { data, error, isLoading } = useSWR(
    "labelerView",
    () => CLIENT.getLabelerView(LABELER_DID),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      ...opts,
    }
  );

  const cons = useMemo(() => {
    if (data == null) {
      return null;
    }

    const cons = data.policies.labelValueDefinitions.map((def) => {
      const [strings] = def.locales;
      const [start, end] = def.fbl_eventInfo.date.split("/");
      return {
        identifier: def.identifier,
        name: strings.name,
        start: parseDate(start, "yyyy-MM-dd", new Date()),
        end: parseDate(end, "yyyy-MM-dd", new Date()),
        location: def.fbl_eventInfo.location,
        rkey: def.fbl_postRkey,
      };
    });

    return sortBy(cons, (con) => con.start);
  }, [data]);

  return { cons, error, isLoading };
}

export function useLikes(uri: string | null, opts?: SWRConfiguration) {
  return useSWR(
    uri != null ? `likes:${uri}` : null,
    async () => {
      const likes = [];
      for await (const like of CLIENT.getLikes(uri!)) {
        likes.push(like);
      }
      return likes;
    },
    { revalidateOnFocus: false, revalidateOnReconnect: false, ...opts }
  );
}

export function useLabels(did: string | null, opts?: SWRConfiguration) {
  return useSWR(
    did != null ? `labels:${did}` : null,
    async () => {
      const labels = new Set();
      for await (const label of CLIENT.getLabels(did!)) {
        labels.add(label);
      }
      return labels;
    },
    { revalidateOnFocus: false, revalidateOnReconnect: false, ...opts }
  );
}

export function useUserViewLabels(opts?: SWRConfiguration) {
  const { userView } = useContext(UserViewContext);
  return useLabels(userView != null ? userView.profile.did : null, opts);
}
