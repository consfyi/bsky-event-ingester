import { ResourceUri } from "@atcute/lexicons";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useClient, useConPosts, useCons } from "~/hooks";

const LocalAttendingContext = createContext({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getIsAttending(id: string): boolean {
    return false;
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setIsAttending(id: string, value: boolean) {},
});

const PENDING = Symbol();

export default function LocalAttendingContextProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const client = useClient();

  const [localIsAttending, setLocalIsAttending] = useState<
    Record<string, boolean>
  >({});

  const [likeUris, setLikeUris] = useState<
    Record<string, ResourceUri | typeof PENDING | null>
  >({});

  const { data: cons } = useCons();
  const { data: conPosts } = useConPosts();

  useEffect(() => {
    if (cons == null || conPosts == null) {
      return;
    }

    const attendingStates: Record<string, boolean> = {};
    const likeUris: Record<string, ResourceUri | typeof PENDING | null> = {};

    for (const con of cons) {
      const conPost = conPosts[con.rkey];
      if (conPost.viewer == null) {
        attendingStates[con.identifier] = false;
        continue;
      }

      attendingStates[con.identifier] = conPost.viewer.like != null;
      likeUris[con.identifier] = conPost.viewer.like ?? null;
    }
    setLocalIsAttending(attendingStates);
    setLikeUris(likeUris);
  }, [conPosts, cons, setLocalIsAttending, setLikeUris]);

  useEffect(() => {
    if (cons == null || conPosts == null) {
      return;
    }

    for (const con of cons) {
      (async (con) => {
        const id = con.identifier;

        if (likeUris[id] == PENDING) {
          return;
        }

        const conPost = conPosts[con.rkey];

        if (localIsAttending[id] && likeUris[id] == null) {
          setLikeUris((likeUris) => ({
            ...likeUris,
            [id]: PENDING,
          }));

          try {
            const r = await client.like(conPost.uri, conPost.cid);
            setLikeUris((likeUris) => ({ ...likeUris, [id]: r! }));
          } catch (e) {
            setLikeUris((likeUris) => ({
              ...likeUris,
              [id]: null,
            }));
          }
        } else if (!localIsAttending[id] && likeUris[id] != null) {
          const likeUri = likeUris[id];
          setLikeUris((likeUris) => ({
            ...likeUris,
            [id]: PENDING,
          }));

          try {
            await client.unlike(likeUri);
            setLikeUris((likeUris) => ({
              ...likeUris,
              [id]: null,
            }));
          } catch (e) {
            setLikeUris((likeUris) => ({
              ...likeUris,
              [id]: likeUri,
            }));
          }
        }
      })(con);
    }
  }, [client, cons, conPosts, likeUris, localIsAttending, setLikeUris]);

  const getIsAttending = useCallback(
    (id: string) => localIsAttending[id] ?? false,
    [localIsAttending]
  );
  const setIsAttending = useCallback(
    (id: string, value: boolean) => {
      setLocalIsAttending((localIsAttending) => ({
        ...localIsAttending,
        [id]: value,
      }));
    },
    [setLocalIsAttending]
  );

  return (
    <LocalAttendingContext.Provider
      value={{
        getIsAttending,
        setIsAttending,
      }}
    >
      {children}
    </LocalAttendingContext.Provider>
  );
}

export function useLocalAttending(id: string | null) {
  const { getIsAttending, setIsAttending } = useContext(LocalAttendingContext);
  const scopedSetIsAttending = useCallback(
    (v: boolean) => {
      if (id == null) {
        return;
      }
      setIsAttending(id, v);
    },
    [id, setIsAttending]
  );

  return {
    isAttending: id != null ? getIsAttending(id) : false,
    setIsAttending: scopedSetIsAttending,
  };
}
